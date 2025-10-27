// service-worker.js - 扩展的中央控制器

import { Storage } from './utils/storage.js';
import { generateUUID } from './utils/uuid.js';
import { resolveUrl } from './utils/url_parser.js';

// --- 生命周期事件 ---
chrome.runtime.onInstalled.addListener(async () => {
    console.log('扩展程序安装完成，开始存储系统初始化...');

    // 初始化存储结构
    const initialData = {
        scripts: [],
        schedules: [],
        shortcuts: {}, // 初始化快捷键为空对象
        logs: [],
        settings: {
            defaultWaitTime: 500,
            defaultTimeout: 30000,
            errorHandlingPolicy: "stop", // 'stop', 'skip', 'retry'
            logRetentionDays: 30
        },
        recordingState: {
            isRecording: false,
            targetTabId: null,
            currentScriptId: null
        },
        playbackQueue: [],
    };

    try {
        await Storage.set(initialData);
        console.log('扩展程序数据初始化成功');
    } catch (error) {
        console.error('初始化存储失败:', error);
    }

    console.log('当前存储类型:', Storage.getStorageType ? Storage.getStorageType() : 'unknown');
});

chrome.runtime.onStartup.addListener(async () => {
    const { schedules } = await Storage.get('schedules');
    if (schedules) {
        for (const schedule of schedules) {
            if (schedule.enabled) {
                // 确保在启动时只注册一次性 monthly alarms
                if (schedule.frequency === 'monthly') {
                    await chrome.alarms.clear(`alarm-${schedule.id}`); // 清除旧的，确保不重复
                }
                registerAlarm(schedule);
            }
        }
    }
});

// --- 监听器 ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handler = messageHandlers[message.type];
    if (handler) {
        handler(message.payload, sender).then(sendResponse);
    }
    return true; // 保持消息通道开放以进行异步响应
});

chrome.commands.onCommand.addListener(handleCommand);
chrome.alarms.onAlarm.addListener(async (alarm) => {
    const { schedules, scripts } = await Storage.get(['schedules', 'scripts']);
    const schedule = schedules.find(s => `alarm-${s.id}` === alarm.name);

    if (schedule && schedule.enabled) {
        const script = scripts.find(s => s.id === schedule.scriptId);
        if (script) {
            // 定时任务只支持后台静默模式
            handleStartPlayback({ scriptId: script.id, mode: 'background', variables: {} });

            // 如果是每月重复，则在执行后重新调度下个月的闹钟
            if (schedule.frequency === 'monthly') {
                const [hours, minutes] = schedule.time.split(':').map(Number);
                const now = new Date();
                let nextScheduledTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0);
                nextScheduledTime.setMonth(nextScheduledTime.getMonth() + 1);

                // 如果计算出的时间在过去，则再加一个月
                if (nextScheduledTime.getTime() < now.getTime()) {
                    nextScheduledTime.setMonth(nextScheduledTime.getMonth() + 1);
                }

                await chrome.alarms.clear(`alarm-${schedule.id}`); // 清除当前闹钟
                chrome.alarms.create(`alarm-${schedule.id}`, {
                    when: nextScheduledTime.getTime()
                });
                console.log(`Monthly Alarm '${schedule.name}' re-scheduled for next month at ${nextScheduledTime.toLocaleString()}.`);
            }
        }
    }
    console.log(`Alarm: ${alarm.name}`);
});
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    handleDownloadRename(item, suggest);
    return true; // 异步操作需要返回true
});



// --- 消息处理器 ---
const messageHandlers = {
    'GET_STATE': handleGetState,
    'START_RECORDING': handleStartRecording,
    'STOP_RECORDING': handleStopRecording,
    'RECORD_ACTION': handleRecordAction,
    'START_PLAYBACK': handleStartPlayback,
    'STEP_COMPLETED': handleStepCompleted,
    // 其他UI请求处理器占位符
    'SAVE_SCRIPT': handleSaveScript,
    'DELETE_SCRIPT': handleDeleteScript,
    'GET_SCRIPTS': handleGetScripts,
    'GET_SETTINGS': handleGetSettings,
    'SAVE_SETTINGS': handleSaveSettings,
    'GET_LOGS': handleGetLogs,
    'SAVE_SCHEDULE': handleSaveSchedule,
    'DELETE_SCHEDULE': handleDeleteSchedule,
    'GET_SCHEDULES': handleGetSchedules,
    'CLEAR_LOGS': handleClearLogs,
    'GET_SHORTCUTS': handleGetShortcuts,
    'SAVE_SHORTCUT': handleSaveShortcut,
    'REMOVE_SHORTCUT': handleRemoveShortcut,
};


async function handleGetState() {
    return await Storage.get(['recordingState', 'playbackQueue']);
}

// 监听扩展图标点击事件
chrome.action.onClicked.addListener(async (tab) => {
    const { recordingState } = await Storage.get('recordingState');
    console.log("扩展图标被点击。当前录制状态:", recordingState.isRecording, "Target Tab ID:", recordingState.targetTabId, "Clicked Tab ID:", tab.id);

    if (tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) {
        console.warn("无法在 chrome:// 或 about: 页面上开始录制。");
        return;
    }

    if (recordingState.isRecording && recordingState.targetTabId === tab.id) {
        // 如果当前标签页正在录制，则停止录制
        await handleStopRecording();
    } else if (recordingState.isRecording && recordingState.targetTabId !== tab.id) {
        // 如果其他标签页正在录制，则停止当前录制，并在新标签页开始
        console.log("当前有其他标签页正在录制，将停止并重新开始。");
        await handleStopRecording(); // 停止当前录制
        const scriptId = generateUUID(); // 在此处生成新的 scriptId
        await handleStartRecording({ tabId: tab.id, url: tab.url, scriptId });
    } else {
        const scriptId = generateUUID(); // 在此处生成新的 scriptId
        await handleStartRecording({ tabId: tab.id, url: tab.url, scriptId });
    }
});

async function handleStartRecording({ tabId, url, scriptId }) {
    console.log(`[Service Worker] handleStartRecording called with: tabId=${tabId}, url=${url}, scriptId=${scriptId}`);
    if (!url || url.startsWith('chrome://') || url.startsWith('about:')) {
        console.error("[Service Worker] 无法在 chrome:// 或 about: 页面上录制。请在普通网页上开始录制。");
        return;
    }

    const newScript = {
        id: scriptId,
        name: `新录制 ${new Date().toLocaleString()}`,
        description: "",
        createdAt: new Date().toISOString(),
        status: 'enabled',
        startUrl: {
            template: url,
            playbackStrategy: 'exact',
        },
        steps: []
    };
    console.log("[Service Worker] New script created:", newScript);

    const { scripts } = await Storage.get('scripts');
    console.log("[Service Worker] Current scripts before push:", scripts);
    scripts.push(newScript);

    console.log("[Service Worker] Setting storage with updated scripts and recording state...");
    await Storage.set({
        scripts,
        recordingState: {
            isRecording: true,
            targetTabId: tabId,
            currentScriptId: scriptId,
        },
    });
    console.log("[Service Worker] Storage updated. Recording state set to true.");

    console.log(`[Service Worker] Attempting to inject recorder.js into tabId: ${tabId}`);
    await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/recorder.js'],
    }).catch(error => {
        console.error('[Service Worker] Failed to inject recorder.js:', error);
    });
    console.log("[Service Worker] Recorder.js injection initiated.");

    console.log("[Service Worker] Setting action icon and badge text...");
    await chrome.action.setIcon({
        path: 'icons/icon48.png',
        tabId
    });
    await chrome.action.setBadgeText({
        text: 'REC',
        tabId
    });
    console.log("[Service Worker] Icon and badge text set.");

    console.log("[Service Worker] Broadcasting state update...");
    await broadcastStateUpdate();
    console.log(`[Service Worker] 已在标签页 ${tabId} 开始录制脚本 ${scriptId}。handleStartRecording function finished.`);
}

async function handleStopRecording() {
    const { recordingState } = await Storage.get('recordingState');
    if (!recordingState.isRecording) {
        console.log("未在录制状态，无需停止。");
        return;
    }

    const tabIdToUpdate = recordingState.targetTabId;

    // 1. 首先通知内容脚本停止监听新事件
    if (tabIdToUpdate) {
        await chrome.tabs.sendMessage(tabIdToUpdate, { type: 'STOP_RECORDING' }).catch(error => {
            console.warn(`向标签页 ${tabIdToUpdate} 发送 STOP_RECORDING 消息失败:`, error.message);
        });
    }

    // 2. 等待一小段时间，让最后一个事件有时间被处理
    await new Promise(resolve => setTimeout(resolve, 300));

    // 3. 清除徽章文本
    await chrome.action.setBadgeText({
        text: '',
        tabId: tabIdToUpdate
    });

    // 4. 更新 Service Worker 中的录制状态
    await Storage.set({
        recordingState: {
            isRecording: false,
            targetTabId: null,
            currentScriptId: null
        }
    });

    // 5. 广播最终状态
    await broadcastStateUpdate();
    console.log(`已停止录制。`);
}


async function handleRecordAction(payload, sender) {
    // 首先从 storage 中获取最新的 recordingState
    const { recordingState } = await Storage.get('recordingState');

    if (!recordingState.isRecording || recordingState.targetTabId !== sender.tab.id) {
        console.log("非当前标签页或未在录制状态，忽略此操作");
        return;
    }

    console.log("接收到录制操作:", payload);
    const { scripts } = await Storage.get('scripts');
    const currentScriptId = recordingState.currentScriptId;

    if (scripts && scripts.length > 0) { // 检查 scripts 是否存在且非空
        const script = scripts.find(s => s.id === currentScriptId);
        if (script) {
            payload.id = generateUUID(); // 给每个步骤生成一个唯一的ID
            script.steps.push(payload);
            await Storage.set({ scripts });
            console.log(`脚本 ${currentScriptId} 已添加步骤。当前步骤数: ${script.steps.length}`);
            broadcastStateUpdate(); // 广播状态更新
        } else {
            console.warn(`脚本 ${currentScriptId} 未找到，无法添加步骤。`);
        }
    } else {
        console.warn("未找到任何脚本，无法添加录制步骤。");
    }
}

async function handleStartPlayback({ scriptId, mode, variables = {} }) {
    const { scripts, playbackQueue } = await Storage.get(['scripts', 'playbackQueue']);
    const script = scripts.find(s => s.id === scriptId);
    if (!script || script.status === 'disabled') {
        console.error("脚本未找到或已禁用");
        return;
    }

    // 实现处理动态变量输入的逻辑
    const finalUrl = resolveUrl(script.startUrl.template, variables);

    const tab = await chrome.tabs.create({
        url: finalUrl,
        active: mode === 'foreground'
    });

    const newTask = {
        taskId: generateUUID(),
        tabId: tab.id,
        scriptId,
        currentStepIndex: 0,
        status: 'running',
        resolvedVariables: variables, // 存储已解析的变量
        mode: mode, // 存储回放模式
        startTime: new Date().toISOString(), // 添加任务开始时间
    };
    playbackQueue.push(newTask);
    await Storage.set({ playbackQueue });

    // 使用 chrome.webNavigation.onCompleted 确保页面完全加载后再注入脚本
    chrome.webNavigation.onCompleted.addListener(async function listener(details) {
        if (details.tabId === tab.id && details.frameId === 0) { // 确保是主框架的加载完成事件
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content/player.js'],
            });
            executeNextStep(newTask);
            chrome.webNavigation.onCompleted.removeListener(listener); // 清理监听器
        }
    });
}

async function executeNextStep(task) {
    const { scripts, playbackQueue } = await Storage.get(['scripts', 'playbackQueue']);
    const script = scripts.find(s => s.id === task.scriptId);

    // 查找任务以确保我们拥有最新的状态
    const currentTaskState = playbackQueue.find(t => t.taskId === task.taskId);
    if (!currentTaskState) {
        console.warn(`在 executeNextStep 期间未在队列中找到任务 ${task.taskId}。可能已完成或取消。`);
        return;
    }

    if (currentTaskState.currentStepIndex >= script.steps.length) {
        await completeTask(currentTaskState);
        return;
    }

    const step = script.steps[currentTaskState.currentStepIndex];
    const nextStep = (currentTaskState.currentStepIndex + 1 < script.steps.length) ? script.steps[currentTaskState.currentStepIndex + 1] : null;

    // 检查当前操作是否预期会触发页面加载
    if (nextStep && nextStep.type === 'pageLoad') {
        console.log(`步骤 ${currentTaskState.currentStepIndex} 预期将触发导航。`);

        // 设置一个监听器，用于导航完成时
        chrome.webNavigation.onCompleted.addListener(async function navigationListener(details) {
            // 确保此监听器仅针对正确的标签页和主框架运行
            if (details.tabId === currentTaskState.tabId && details.frameId === 0) {
                console.log(`标签页 ${details.tabId} 的导航已完成。正在重新注入播放器并继续播放。`);

                // 将播放器脚本重新注入新页面
                await chrome.scripting.executeScript({
                    target: { tabId: currentTaskState.tabId },
                    files: ['content/player.js'],
                }).catch(err => console.error("导航后重新注入播放器脚本失败:", err));

                // 更新任务状态：跳过操作和 pageLoad 步骤
                const { playbackQueue: currentQueue } = await Storage.get('playbackQueue');
                const taskToUpdateIndex = currentQueue.findIndex(t => t.taskId === currentTaskState.taskId);
                if (taskToUpdateIndex !== -1) {
                    currentQueue[taskToUpdateIndex].currentStepIndex += 2; // 跳过当前操作和 pageLoad 步骤
                    await Storage.set({ playbackQueue: currentQueue });

                    // 从 pageLoad 后的步骤继续执行
                    executeNextStep(currentQueue[taskToUpdateIndex]);
                }

                // 重要：移除此监听器以防止其再次触发
                chrome.webNavigation.onCompleted.removeListener(navigationListener);
            }
        });

        // 执行将触发导航的操作
        // 我们不期望收到 STEP_COMPLETED 消息，因为上下文将被销毁。
        chrome.tabs.sendMessage(currentTaskState.tabId, {
            type: 'EXECUTE_STEP',
            payload: { step, taskId: currentTaskState.taskId }
        }).catch(err => console.warn(`发送导航触发步骤时出错，如果页面快速卸载，这是正常现象:`, err.message));

    } else {
        // 这是一个普通步骤，不会触发导航。
        // 期望收到 STEP_COMPLETED 消息。
        chrome.tabs.sendMessage(currentTaskState.tabId, {
            type: 'EXECUTE_STEP',
            payload: { step, taskId: currentTaskState.taskId }
        }).catch(async (error) => {
            console.error(`发送步骤 ${currentTaskState.currentStepIndex} 的消息失败。错误: ${error.message}。假设标签页已关闭或无响应。`);
            // 如果发送失败，我们无法继续。将任务标记为失败。
            const { playbackQueue: currentQueue } = await Storage.get('playbackQueue');
            const taskToUpdate = currentQueue.find(t => t.taskId === currentTaskState.taskId);
            if(taskToUpdate) {
                taskToUpdate.status = 'error';
                await Storage.set({ playbackQueue: currentQueue });
                await logTaskCompletion(taskToUpdate, 'failed', `在步骤 ${taskToUpdate.currentStepIndex} 处失败: 标签页无响应或已关闭。`);
            }
        });
    }
}

async function handleStepCompleted({ taskId, result }) {
    const { playbackQueue, settings, scripts } = await Storage.get(['playbackQueue', 'settings', 'scripts']);
    const taskIndex = playbackQueue.findIndex(t => t.taskId === taskId);
    if (taskIndex === -1) {
        console.warn(`handleStepCompleted: 未找到任务 ${taskId}，可能已被处理或取消。`);
        return;
    }

    const task = playbackQueue[taskIndex];
    const script = scripts.find(s => s.id === task.scriptId);
    if (!script) {
        console.error(`handleStepCompleted: 未找到任务 ${taskId} 对应的脚本 ${task.scriptId}。`);
        return;
    }

    // --- 新增的导航检查 ---
    const currentStepIndex = task.currentStepIndex;
    const nextStep = (currentStepIndex + 1 < script.steps.length) ? script.steps[currentStepIndex + 1] : null;

    if (nextStep && nextStep.type === 'pageLoad') {
        // 如果此步骤之后是 pageLoad，则表示它是一个导航步骤。
        // 它的流程由 webNavigation.onCompleted 监听器处理。
        // 我们应该忽略此处的 STEP_COMPLETED 消息，因为它可能是页面卸载前发出的。
        console.log(`忽略来自导航触发步骤 ${currentStepIndex} 的 STEP_COMPLETED 消息。`);
        return;
    }
    // --- 检查结束 ---

    if (result.success) {
        task.currentStepIndex++;
        await Storage.set({ playbackQueue });
        executeNextStep(task);
    } else {
        task.errorInfo = result.error;
        const errorHandlingPolicy = settings.errorHandlingPolicy || 'stop';

        if (errorHandlingPolicy === 'retry') {
            console.warn(`任务 ${taskId} 在步骤 ${task.currentStepIndex} 失败，尝试重试...`);
            await Storage.set({ playbackQueue }); // 更新状态以反映重试
            executeNextStep(task);
        } else if (errorHandlingPolicy === 'skip') {
            console.warn(`任务 ${taskId} 在步骤 ${task.currentStepIndex} 失败，跳过该步骤...`);
            task.currentStepIndex++; // 跳过当前步骤
            await Storage.set({ playbackQueue });
            executeNextStep(task);
        } else { // 'stop'
            task.status = 'error';
            await Storage.set({ playbackQueue });
            await logTaskCompletion(task, 'failed', `在步骤 ${task.currentStepIndex} 处失败: ${result.error}`);
            console.error(`任务 ${taskId} 在步骤 ${task.currentStepIndex} 失败，已停止。`);
        }
    }
}

async function completeTask(task) {
    task.status = 'completed';
    const { playbackQueue } = await Storage.get('playbackQueue');
    const updatedQueue = playbackQueue.filter(t => t.taskId !== task.taskId);
    await Storage.set({ playbackQueue: updatedQueue });
    await logTaskCompletion(task, 'success', "任务成功完成");

    // 如果是后台任务，自动关闭标签页
    if (task.mode === 'background') {
        await chrome.tabs.remove(task.tabId);
    }
}


// --- 其他处理器 ---
async function handleCommand(command) {
    const { shortcuts, scripts } = await Storage.get(['shortcuts', 'scripts']);
    const shortcutConfig = shortcuts[command]; // 直接通过 command 查找

    if (shortcutConfig) {
        const script = scripts.find(s => s.id === shortcutConfig.scriptId);
        if (script) {
            handleStartPlayback({ scriptId: script.id, mode: shortcutConfig.mode || 'foreground', variables: {} });
            console.log(`快捷键 '${command}' 已触发脚本: ${script.name}`);
        } else {
            console.warn(`快捷键 '${command}' 对应的脚本未找到或已被删除。`);
        }
    } else {
        console.log(`Command: ${command} - 未配置快捷键。`);
    }
}

async function handleDownloadRename(downloadItem, suggest) {
    const { playbackQueue, scripts } = await Storage.get(['playbackQueue', 'scripts']);
    const task = playbackQueue.find(t => t.tabId === downloadItem.tabId);
    if (!task) {
        suggest(); // 没有关联任务，使用默认行为
        return;
    }

    const script = scripts.find(s => s.id === task.scriptId);
    // 注意：这里的 currentStepIndex 可能因为异步而超前，需要更精确的关联
    // 假设下载是由上一步触发的，或者需要一个更精确的机制来匹配下载和步骤
    const step = script.steps.find(s => s.type === 'click' && s.triggerDownload && s.id === downloadItem.referrer); // 这是一个简化，需要更复杂的匹配逻辑

    if (step && step.renameRule) {
        const newFilename = resolveUrl(step.renameRule, task.resolvedVariables);
        suggest({
            filename: newFilename,
            conflictAction: 'uniquify'
        });
    } else {
        suggest(); // 没有重命名规则，使用默认行为
    }
}


async function logTaskCompletion(task, status, summary) {
    const { logs, settings, scripts } = await Storage.get(['logs', 'settings', 'scripts']);
    const script = scripts.find(s => s.id === task.scriptId);
    const scriptName = script ? script.name : '未知脚本';

    const newLogEntry = {
        id: generateUUID(),
        scriptName: scriptName,
        startTime: new Date(task.startTime).toISOString(),
        endTime: new Date().toISOString(),
        durationMs: Date.now() - new Date(task.startTime).getTime(),
        status: status,
        message: summary, // 添加 message 字段
        type: status,    // 添加 type 字段
        trigger: 'manual', // 默认为手动触发，实际应从任务中获取
        mode: task.mode,
        summary: summary,
        downloadedFiles: [], // TODO: 填充下载文件信息
    };

    logs.push(newLogEntry);

    // 清理旧日志
    const retentionDate = new Date();
    retentionDate.setDate(retentionDate.getDate() - (settings.logRetentionDays || 30));
    const filteredLogs = logs.filter(log => new Date(log.startTime) > retentionDate);

    await Storage.set({ logs: filteredLogs });
    // 通知 UI 任务状态更新
    chrome.runtime.sendMessage({ type: 'STATE_UPDATED', payload: { playbackQueue: (await Storage.get('playbackQueue')).playbackQueue, recordingState: (await Storage.get('recordingState')).recordingState, logs: filteredLogs } });
    console.log(`任务 ${task.taskId} ${status}.`);
}

// 辅助函数：注册 alarm
async function registerAlarm(schedule) {
    const [hours, minutes] = schedule.time.split(':').map(Number);
    const now = new Date();
    let scheduledTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0);

    if (scheduledTime.getTime() < now.getTime()) {
        // 如果时间已过，安排在明天或下周、下月
        if (schedule.frequency === 'daily') {
            scheduledTime.setDate(scheduledTime.getDate() + 1);
        } else if (schedule.frequency === 'weekly') {
            scheduledTime.setDate(scheduledTime.getDate() + 7);
        } else if (schedule.frequency === 'monthly') {
            scheduledTime.setMonth(scheduledTime.getMonth() + 1);
        }
    }

    const alarmInfo = {
        when: scheduledTime.getTime()
    };

    if (schedule.frequency === 'daily') {
        alarmInfo.periodInMinutes = 24 * 60; // 每天重复
    } else if (schedule.frequency === 'weekly') {
        alarmInfo.periodInMinutes = 7 * 24 * 60; // 每周重复
    }
    // 对于 monthly，不设置 periodInMinutes，在 handleAlarm 中重新调度

    chrome.alarms.create(`alarm-${schedule.id}`, alarmInfo);
    console.log(`Alarm '${schedule.name}' for script '${schedule.scriptId}' registered to run at ${schedule.time} with frequency ${schedule.frequency}.`);
}


// 示例 UI 请求处理器
async function handleSaveScript({ script }) {
    let { scripts } = await Storage.get('scripts');
    const index = scripts.findIndex(s => s.id === script.id);
    if (index > -1) {
        scripts[index] = script;
    } else {
        scripts.push(script);
    }
    await Storage.set({ scripts });
    await broadcastStateUpdate(); // 添加广播
    return { success: true };
}

async function handleDeleteScript({ scriptId }) {
    let { scripts } = await Storage.get('scripts');
    scripts = scripts.filter(s => s.id !== scriptId);
    await Storage.set({ scripts });
    return { success: true };
}

async function handleGetScripts() {
    return await Storage.get('scripts');
}

async function handleGetSettings() {
    return await Storage.get('settings');
}

async function handleSaveSettings({ settings }) {
    await Storage.set({ settings });
    return { success: true };
}

async function handleGetLogs() {
    return await Storage.get('logs');
}

async function handleClearLogs() {
    await Storage.set({ logs: [] });
    return { success: true };
}

async function handleGetSchedules() {
    return await Storage.get('schedules');
}

async function handleSaveSchedule({ schedule }) {
    let { schedules } = await Storage.get('schedules');
    const index = schedules.findIndex(s => s.id === schedule.id);
    if (index > -1) {
        schedules[index] = schedule;
    } else {
        schedules.push(schedule);
    }
    await Storage.set({ schedules });

    // 如果定时任务被启用，则注册/更新 alarm
    if (schedule.enabled) {
        await registerAlarm(schedule);
    } else {
        // 如果禁用，则清除 alarm
        await chrome.alarms.clear(`alarm-${schedule.id}`);
    }
    return { success: true };
}

async function handleDeleteSchedule({ scheduleId }) {
    let { schedules } = await Storage.get('schedules');
    schedules = schedules.filter(s => s.id !== scheduleId);
    await Storage.set({ schedules });

    // 清除关联的 alarm
    await chrome.alarms.clear(`alarm-${scheduleId}`);
    await broadcastStateUpdate(); // 添加广播
    return { success: true };
}

async function handleGetShortcuts() {
    return await Storage.get('shortcuts');
}

async function handleSaveShortcut({ shortcut }) {
    let { shortcuts } = await Storage.get('shortcuts');
    shortcuts[shortcut.command] = {
        scriptId: shortcut.scriptId,
        mode: shortcut.mode
    };
    await Storage.set({ shortcuts });
    await broadcastStateUpdate();
    return { success: true };
}

async function handleRemoveShortcut({ command }) {
    let { shortcuts } = await Storage.get('shortcuts');
    delete shortcuts[command];
    await Storage.set({ shortcuts });
    await broadcastStateUpdate();
    return { success: true };
}

// Helper to broadcast state updates
async function broadcastStateUpdate() {
    const { playbackQueue, recordingState, logs, scripts, schedules, settings } = await Storage.get(['playbackQueue', 'recordingState', 'logs', 'scripts', 'schedules', 'settings']);
    chrome.runtime.sendMessage({
        type: 'STATE_UPDATED',
        payload: { playbackQueue, recordingState, logs, scripts, schedules, settings }
    }).catch(e => console.warn("Error sending STATE_UPDATED message:", e));
}
