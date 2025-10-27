// 测试 chrome.storage.local 功能的独立脚本
// 这个脚本会在浏览器环境中运行

async function testStorage() {
    try {
        console.log('开始测试 chrome.storage.local...');

        // 测试1: 基本设置和获取
        await chrome.storage.local.set({testKey: 'testValue'});
        console.log('设置 testKey = testValue');

        const result = await chrome.storage.local.get('testKey');
        console.log('获取 testKey:', result.testKey);

        if (result.testKey === 'testValue') {
            console.log('✅ chrome.storage.local 基本功能正常');
            return true;
        } else {
            console.log('❌ chrome.storage.local 返回值不正确');
            return false;
        }
    } catch (error) {
        console.log('❌ chrome.storage.local 错误:', error);
        return false;
    }
}

// 运行测试
testStorage().then(success => {
    console.log('存储测试完成，结果:', success ? '通过' : '失败');
});