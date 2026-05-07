let apiConfig;
let lastRequestTime = 0;
let currentAudioURL = null;
let requestCounter = 0;
let isGenerating = false;
// Abort controller for cancellable generation requests
let currentAbortController = null;
let cancelRequested = false;
// Sequential playback queue for long-text generation
let playbackQueue = [];
let isQueuePlaying = false;
let queueModeActive = false;
let isLongTextGenerating = false;

// 清理 Markdown 标记与链接，避免被朗读
function stripMarkdown(input) {
    if (!input) return '';
    let text = input;
    // 1) 代码块 ``` ```
    text = text.replace(/```[\s\S]*?```/g, '');
    // 2) 行内代码 `code`
    text = text.replace(/`[^`]*`/g, '');
    // 3) 标题 #, ##, ### 前缀
    text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    // 4) 列表标记 -, *, + 开头
    text = text.replace(/^\s*[-*+]\s+/gm, '');
    // 6) 加粗/斜体 **text** *text* __text__ _text_
    text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
    text = text.replace(/\*([^*]+)\*/g, '$1');
    text = text.replace(/__([^_]+)__/g, '$1');
    text = text.replace(/_([^_]+)_/g, '$1');
    // 7) 链接与图片 [text](url) ![alt](url)
    text = text.replace(/!\[[^\]]*\]\([^\)]*\)/g, '');
    text = text.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, '$1');
    // 7.1) HTML 链接 <a href="...">text</a> 保留可读文本，去掉标签与URL
    text = text.replace(/<a\s+[^>]*href=("|')[^"']+("|')[^>]*>(.*?)<\/a>/gi, '$3');
    // 7.2) HTML 图片直接移除
    text = text.replace(/<img\s+[^>]*>/gi, '');
    // 7.3) 自动链接 <https://...>
    text = text.replace(/<https?:\/\/[^>\s]+>/gi, '');
    text = text.replace(/<www\.[^>\s]+>/gi, '');
    // 7.4) 纯 URL（http/https/ftp 或 www 开头）
    text = text.replace(/\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<)]+/gi, '');
    // 7.5) 域名路径（example.com/.. 等常见顶级域名）
    text = text.replace(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io|ai|cn|xyz|top|info|me|site|club|dev|app|tech|tv|gg|so|uk|jp|de|fr|au|ca|us|hk|sg)(?:\/[\S]*)?/gi, '');
    // 7.6) 邮箱
    text = text.replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gi, '');
    // 8) 引用行 >
    text = text.replace(/^\s*>+\s?/gm, '');
    // 9) 水平线 --- *** ___
    text = text.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '');
    // 10) 转义反斜杠 \\*
    text = text.replace(/\\([*_`\[\]()>#+\-])/g, '$1');
    // 11) 剩余孤立 Markdown 符号清理（避免误删 HTML/比较符号，不处理 '>'）
    text = text.replace(/[#*_`]+/g, '');
    // 12) 清理 emoji / icon（含 keycap、旗帜、ZWJ 组合）
    text = text.replace(/(?:[#*0-9]️?⃣|[\u{1F1E6}-\u{1F1FF}]{2}|(?:\p{Extended_Pictographic}(?:︎|️)?(?:\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:︎|️)?(?:\p{Emoji_Modifier})?)*))/gu, '');
    text = text.replace(/[‍︎️]/g, '');
    // 13) 多空白合并
    text = text.replace(/[\t\f\v]+/g, ' ');
    text = text.replace(/\s{2,}/g, ' ');
    // 14) 多个空行压缩
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

// ===================== 持久化（文本/音频/播放进度） =====================
let audioDbPromise = null;

function openAudioDb() {
    if (audioDbPromise) return audioDbPromise;
    audioDbPromise = new Promise((resolve, reject) => {
        try {
            const request = indexedDB.open('libretts-db', 1);
            request.onupgradeneeded = function(event) {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('audios')) {
                    db.createObjectStore('audios');
                }
            };
            request.onsuccess = e => resolve(e.target.result);
            request.onerror = e => reject(e.target.error || new Error('IndexedDB open failed'));
        } catch (e) { reject(e); }
    });
    return audioDbPromise;
}

async function persistAudio(blob) {
    try {
        const db = await openAudioDb();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction('audios', 'readwrite');
            tx.objectStore('audios').put(blob, 'current');
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.error('保存音频失败:', e);
    }
}

async function readPersistedAudio() {
    try {
        const db = await openAudioDb();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction('audios', 'readonly');
            const req = tx.objectStore('audios').get('current');
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        console.error('读取音频失败:', e);
        return null;
    }
}

function throttle(fn, intervalMs) {
    let last = 0;
    return function(...args) {
        const now = Date.now();
        if (now - last >= intervalMs) {
            last = now;
            fn.apply(this, args);
        }
    };
}

function attachAudioPersistenceHandlers() {
    const audio = document.getElementById('audio');
    if (!audio) return;
    const saveProgress = throttle(() => {
        try {
            localStorage.setItem('player.currentTime', String(audio.currentTime || 0));
        } catch (e) {}
    }, 500);
    audio.addEventListener('timeupdate', saveProgress);
    audio.addEventListener('play', () => { try { localStorage.setItem('player.isPlaying', 'true'); } catch (e) {} });
    audio.addEventListener('pause', () => { try { localStorage.setItem('player.isPlaying', 'false'); } catch (e) {} });
}

async function restoreState() {
    try {
        const lastText = localStorage.getItem('lastText');
        if (lastText !== null) {
            $('#text').val(lastText);
            updateCharCountText();
        }
        const wasPlaying = localStorage.getItem('player.isPlaying') === 'true';
        const lastTime = parseFloat(localStorage.getItem('player.currentTime') || '0');
        const blob = await readPersistedAudio();
        if (blob) {
            if (currentAudioURL) URL.revokeObjectURL(currentAudioURL);
            currentAudioURL = URL.createObjectURL(blob);
            $('#result').show();
            $('#audio').attr('src', currentAudioURL);
            $('#download').removeClass('disabled').attr('href', currentAudioURL);
            const audioEl = document.getElementById('audio');
            audioEl.onloadedmetadata = function() {
                if (!isNaN(lastTime) && lastTime > 0 && lastTime < (audioEl.duration || Infinity)) {
                    audioEl.currentTime = lastTime;
                }
                if (wasPlaying) {
                    audioEl.play().catch(() => {});
                }
                audioEl.onloadedmetadata = null;
            };
        }
    } catch (e) {
        console.error('恢复状态失败:', e);
    }
}

// 获取后端基础 URL
function getBaseUrl() {
    let baseUrl = localStorage.getItem('backend_base_url') || '';
    if (baseUrl && baseUrl.endsWith('/')) {
        baseUrl = baseUrl.slice(0, -1);
    }
    return baseUrl;
}

function isCordovaApp() {
    return window.location.protocol === 'file:' || window.cordova;
}

function requireBackendBaseUrl() {
    const baseUrl = getBaseUrl();
    if (!baseUrl && isCordovaApp()) {
        $('#backendUrlModal').modal('show');
        throw new Error('App 端需要先在“云端后台设置”里填写网页版服务器地址，例如 https://你的域名');
    }
    return baseUrl;
}

const API_CONFIG = {
    'edge-api': {
        get url() { return getBaseUrl() + '/api/tts'; }
    },
    'azure-tts-1': {
        get url() { return getBaseUrl() + '/api/azure-tts'; }, // 使用后端转发
        format: 'azure-ssml'   // 标记为 Azure SSML 格式，以便区分处理
    }
};

// 在API_CONFIG对象之后添加
let customAPIs = {};
let editingApiId = null;

function loadSpeakers() {
    return $.ajax({
        url: 'speakers.json',
        method: 'GET',
        dataType: 'json',
        cache: false,
        success: function(data) {
            apiConfig = data;
            
            // 加载自定义API
            loadCustomAPIs();
            
            // 更新API选择下拉菜单
            updateApiOptions();
            
            // 设置默认API
            updateSpeakerOptions($('#api').val());
        },
        error: function(jqXHR, textStatus, errorThrown) {
            console.error(`加载讲述者失败：${textStatus} - ${errorThrown}`);
            showError('加载讲述者失败，请刷新页面重试。');
        }
    });
}

// 加载自定义API配置
function loadCustomAPIs() {
    try {
        const savedAPIs = localStorage.getItem('customAPIs');
        if (savedAPIs) {
            customAPIs = JSON.parse(savedAPIs);
            
            // 合并到API_CONFIG
            Object.keys(customAPIs).forEach(apiId => {
                API_CONFIG[apiId] = {
                    url: customAPIs[apiId].endpoint,
                    isCustom: true,
                    apiKey: customAPIs[apiId].apiKey,
                    format: customAPIs[apiId].format,
                    manual: customAPIs[apiId].manual,
                    maxLength: customAPIs[apiId].maxLength
                };
            });
        }
    } catch (error) {
        console.error('加载自定义API失败:', error);
    }
}

// 更新API选择下拉菜单
function updateApiOptions() {
    const apiSelect = $('#api');
    
    // 保存当前选择
    const currentApi = apiSelect.val();
    
    // 清除除了内置选项之外的所有选项
    apiSelect.find('option:not([value="edge-api"]):not([value="azure-tts-1"])').remove();
    
    // 添加自定义API选项
    Object.keys(customAPIs).forEach(apiId => {
        apiSelect.append(new Option(customAPIs[apiId].name, apiId));
    });
    
    // 如果之前选择的是有效的选项，则恢复选择
    if (currentApi && (currentApi === 'edge-api' || currentApi === 'azure-tts-1' || customAPIs[currentApi])) {
        apiSelect.val(currentApi);
    }
}

// 更新讲述者选项列表
async function updateSpeakerOptions(apiName) {
    const speakerSelect = $('#speaker');
    speakerSelect.empty().append(new Option('加载中...', ''));
    const storageKey = `lastSpeaker.${apiName}`;

    const applySavedSelection = () => {
        try {
            const options = speakerSelect.find('option');
            if (!options.length) return;

            const saved = localStorage.getItem(storageKey);
            if (saved) {
                const hasSaved = options.filter(function() {
                    return $(this).val() === saved;
                });
                if (hasSaved.length) {
                    speakerSelect.val(saved);
                    return;
                }
            }

            const firstValid = options.filter(function() {
                const value = $(this).val();
                return value !== null && value !== '';
            }).first();

            if (firstValid.length) {
                const value = firstValid.val();
                speakerSelect.val(value);
                localStorage.setItem(storageKey, value);
            } else {
                speakerSelect.val(options.first().val() || '');
            }
        } catch (error) {
            console.warn('恢复讲述者选择失败:', error);
        }
    };
    
    try {
        // 检查是否是自定义API
        if (customAPIs[apiName]) {
            const customApi = customAPIs[apiName];
            
            // 如果有手动设置的讲述人列表，使用它
            if (customApi.manual && customApi.manual.length) {
                speakerSelect.empty();
                customApi.manual.forEach(v => speakerSelect.append(new Option(v, v)));
                applySavedSelection();
            } 
            // 如果有API密钥和模型端点，尝试获取讲述人
            else if (customApi.apiKey && customApi.modelEndpoint) {
                try {
                    const speakers = await fetchCustomSpeakers(apiName);
                    speakerSelect.empty();
                    
                    if (Object.keys(speakers).length === 0) {
                        speakerSelect.append(new Option('未找到讲述人，请手动添加', ''));
                    } else {
                        Object.entries(speakers).forEach(([key, value]) => {
                            speakerSelect.append(new Option(value, key));
                        });
                    }
                    applySavedSelection();
                } catch (error) {
                    console.error('获取自定义讲述人失败:', error);
                    speakerSelect.empty().append(new Option('获取讲述人失败，请手动添加', ''));
                }
            } else {
                speakerSelect.empty().append(new Option('请先获取模型或手动输入讲述人', ''));
            }
        } else if (apiConfig[apiName]) {
            // 使用预定义的speakers
            const speakers = apiConfig[apiName].speakers;
            speakerSelect.empty();
            
            Object.entries(speakers).forEach(([key, value]) => {
                speakerSelect.append(new Option(value, key));
            });
            applySavedSelection();
        } else {
            throw new Error(`未知的API: ${apiName}`);
        }
    } catch (error) {
        console.error('加载讲述者失败:', error);
        speakerSelect.empty().append(new Option('加载讲述者失败', ''));
        showError(`加载讲述者失败: ${error.message}`);
    }
    
    // 更新API提示信息
    updateApiTipsText(apiName);
}

// 从自定义API获取讲述者
async function fetchCustomSpeakers(apiId) {
    const customApi = customAPIs[apiId];
    if (!customApi || !customApi.modelEndpoint) {
        return { 'default': '默认讲述者' };
    }
    
    try {
        const headers = {
            'Content-Type': 'application/json'
        };
        
        // 如果有API密钥，添加授权头
        if (customApi.apiKey) {
            headers['Authorization'] = `Bearer ${customApi.apiKey}`;
        }
        
        const response = await fetch(customApi.modelEndpoint, {
            method: 'GET',
            headers: headers
        });
        
        if (!response.ok) {
            throw new Error(`获取讲述者失败: ${response.status}`);
        }
        
        const data = await response.json();
        
        // 处理OpenAI格式的响应
        if (data.data && Array.isArray(data.data)) {
            const ttsModels = data.data.filter(model => 
                model.id.startsWith('tts-') || 
                ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].includes(model.id)
            );
            
            if (ttsModels.length === 0) {
                return { 'default': '未找到TTS模型' };
            }
            
            // 创建讲述者映射
            const speakerMap = {};
            ttsModels.forEach(model => {
                speakerMap[model.id] = model.id;
            });
            
            // 保存到apiConfig以便后续使用
            if (!apiConfig[apiId]) {
                apiConfig[apiId] = {};
            }
            apiConfig[apiId].speakers = speakerMap;
            
            return speakerMap;
        } else {
            // 如果响应格式不匹配预期
            console.warn('API返回格式不是标准OpenAI格式:', data);
            return { 'default': '自定义讲述人' };
        }
    } catch (error) {
        console.error('获取自定义讲述者失败:', error);
        return { 'error': `错误: ${error.message}` };
    }
}

// 更新API提示文本
function updateApiTipsText(apiName) {
    const tips = {
        'edge-api': 'Edge API 请求应该不限次数',
        'azure-tts-1': 'Azure TTS API (官方接口)'
    };

    // 如果是自定义API
    if (customAPIs[apiName]) {
        const format = customAPIs[apiName].format || 'openai';
        const formatStr = format === 'openai' ? 'OpenAI格式' : 'Edge API格式';
        $('#apiTips').text(`自定义API: ${customAPIs[apiName].name} - 使用${formatStr}`);
    } else {
        $('#apiTips').text(tips[apiName] || '');
    }

    // 根据API类型调整界面
    if (customAPIs[apiName] && customAPIs[apiName].format === 'openai') {
        $('#instructionsContainer').show();
        $('#formatContainer').show();
        $('#rateContainer, #pitchContainer').hide();
        $('#pauseControls').hide(); // 隐藏停顿控制
    } else {
        $('#instructionsContainer').hide();
        $('#formatContainer').hide();
        $('#rateContainer, #pitchContainer').show();
        $('#pauseControls').show(); // 显示停顿控制
    }

    // 更新字符限制提示文本
    updateCharCountText();

    // 根据API类型调整"生成并播放"按钮的位置
    // 需求：当自定义为 OpenAI 格式时，将按钮移动到"语音指令（可选）"上方
    try {
        const playGroup = $('#playButton').closest('.form-group');
        const instructionsGroup = $('#instructionsContainer');
        const formatGroup = $('#formatContainer');
        // 创建占位符，便于需要时恢复相对位置
        if ($('#playButtonPlaceholder').length === 0) {
            $('<span id="playButtonPlaceholder" style="display:none"></span>').insertAfter(playGroup);
        }
        if (customAPIs[apiName] && customAPIs[apiName].format === 'openai') {
            // 移动到"语音指令"上方
            if (instructionsGroup.length) {
                playGroup.insertBefore(instructionsGroup);
            }
        } else {
            // 恢复到默认：位于格式容器之后（与原布局一致）
            if (formatGroup.length) {
                playGroup.insertAfter(formatGroup);
            }
        }
    } catch (e) {
        console.warn('调整播放按钮位置失败:', e);
    }
}

function updateSliderLabel(sliderId, labelId) {
    const slider = $(`#${sliderId}`);
    const label = $(`#${labelId}`);
    label.text(slider.val());
    
    slider.off('input').on('input', function() {
        label.text(this.value);
    });
}

// 后端 URL 保存功能
function saveBackendUrl() {
    let url = $('#backendBaseUrl').val().trim();
    if (url.endsWith('/')) {
        url = url.slice(0, -1);
    }
    if (url && !/^https:\/\//i.test(url)) {
        showError('App 端服务器地址必须以 https:// 开头');
        return;
    }
    localStorage.setItem('backend_base_url', url);
    $('#backendUrlModal').modal('hide');
    showInfo('后端服务器地址已保存！');
}

$(document).ready(function() {
    // 恢复后端 URL 设置
    $('#backendBaseUrl').val(localStorage.getItem('backend_base_url') || '');

    // 确保默认API选择为edge-api
    if ($('#api').length && !$('#api').val()) {
        $('#api').val('edge-api');
    }
    loadSpeakers().then(() => {
        $('#apiTips').text('Edge API 请求应该不限次数');
        
        // 初始化音频播放器
        initializeAudioPlayer();
        // 恢复上次会话的文本/音频/播放进度
        restoreState();
        // 监听音频与文本的持久化
        attachAudioPersistenceHandlers();
        
        $('[data-toggle="tooltip"]').tooltip();

        $('#api').on('change', function() {
            const apiName = $(this).val();
            updateSpeakerOptions(apiName);
            
            $('#rate, #pitch').val(0);
            updateSliderLabel('rate', 'rateValue');
            updateSliderLabel('pitch', 'pitchValue');
            
            // 根据选择的API更新提示信息
            const tips = {
                'edge-api': 'Edge API 请求应该不限次数'
            };
            $('#apiTips').text(tips[apiName] || '');

            // 根据API显示或隐藏instructions输入框和停顿功能
            // 移除了 oai-tts 的判断逻辑，仅保留自定义API判断
            if (customAPIs[apiName] && customAPIs[apiName].format === 'openai') {
                $('#instructionsContainer').show();
                $('#formatContainer').show();
                $('#rateContainer, #pitchContainer').hide();
                $('#pauseControls').hide(); // 隐藏停顿控制

                // 更新字符限制提示文本
                updateCharCountText();
            } else {
                $('#instructionsContainer').hide();
                $('#formatContainer').hide();
                $('#rateContainer, #pitchContainer').show();
                $('#pauseControls').show(); // 显示停顿控制

                // 恢复默认字符限制提示文本
                updateCharCountText();
            }
        });

        updateSliderLabel('rate', 'rateValue');
        updateSliderLabel('pitch', 'pitchValue');

        $('#speaker').on('change', function() {
            const apiName = $('#api').val();
            const value = $(this).val();
            try {
                if (value) {
                    localStorage.setItem(`lastSpeaker.${apiName}`, value);
                } else {
                    localStorage.removeItem(`lastSpeaker.${apiName}`);
                }
            } catch (error) {
                console.warn('保存讲述者选择失败:', error);
            }
        });

        // 按钮事件改为事件委托，移至文档级绑定

        $('#text').on('input', function() {
            updateCharCountText();
            try { localStorage.setItem('lastText', $(this).val()); } catch (e) {}
        });

        // 清空文本按钮（使用事件委托）

        // 添加插入停顿功能
        $('#insertPause').on('click', function() {
            const seconds = parseFloat($('#pauseSeconds').val());
            if (isNaN(seconds) || seconds < 0.01 || seconds > 100) {
                showError('请输入0.01到100之间的数字');
                return;
            }
            
            const textarea = $('#text')[0];
            const cursorPos = textarea.selectionStart;
            const textBefore = textarea.value.substring(0, cursorPos);
            const textAfter = textarea.value.substring(textarea.selectionEnd);
            
            // 插入停顿标记
            const pauseTag = `<break time="${seconds}s"/>`;
            textarea.value = textBefore + pauseTag + textAfter;
            
            // 恢复光标位置
            const newPos = cursorPos + pauseTag.length;
            textarea.setSelectionRange(newPos, newPos);
            textarea.focus();
        });

        // 限制输入数字范围
        $('#pauseSeconds').on('input', function() {
            let value = parseFloat($(this).val());
            if (value > 100) $(this).val(100);
            if (value < 0.01 && value !== '') $(this).val(0.01);
        });
    });
    
    // 事件委托：清空文本
    $(document).on('click', '#clearTextBtn', function() {
        $('#text').val('').trigger('input');
        $('#text').focus();
    });

    // 事件委托：生成语音
    $(document).on('click', '#generateButton', function() {
        if (canMakeRequest()) {
            console.log('[UI] 点击：生成语音');
            generateVoice(false);
        } else {
            showError('请稍候再试，3秒只能请求一次。');
        }
    });

    // 事件委托：试听前20个字
    $(document).on('click', '#previewButton', function() {
        if (canMakeRequest()) {
            console.log('[UI] 点击：试听前20个字');
            generateVoice(true);
        } else {
            showError('请稍候再试，每3秒只能请求一次。');
        }
    });

    // 事件委托：生成并播放（支持停止）
    $(document).on('click', '#playButton', function() {
        const $btn = $('#playButton');
        // 如果正在生成，则点击为"停止"行为，并立即恢复按钮初始状态
        if (isGenerating) {
            cancelRequested = true;
            if (currentAbortController) {
                try { currentAbortController.abort(); } catch (e) {}
            }
            queueModeActive = false;
            // 清空播放队列并停止当前播放
            try {
                playbackQueue.forEach(url => URL.revokeObjectURL(url));
                playbackQueue = [];
                isQueuePlaying = false;
            } catch (e) {}
            const audioEl = $('#audio')[0];
            if (audioEl && !audioEl.paused) {
                audioEl.pause();
            }
            hideLoading();
            isGenerating = false;
            // 恢复按钮为"生成并播放"
            const orig = $btn.data('origHtml');
            $btn.html(orig || '<i class="fas fa-play-circle mr-2"></i>生成并播放');
            $btn.prop('disabled', false);
            showInfo('已停止生成');
            console.log('[UI] 点击：停止生成');
            return;
        }
        if (canMakeRequest()) {
            console.log('[UI] 点击：生成并播放');
            generateVoice(false, true);
        } else {
            showError('请稍候再试，3秒只能请求一次。');
        }
    });
    
    // 添加自定义API管理功能
    $('#manageApiBtn').on('click', function() {
        editingApiId = null;
        $('#customApiForm')[0].reset();
        $('#apiFormat').val('openai');
        $('#manualSpeakers').val('');
        $('#maxLength').val('');
        updateApiFormPlaceholders('openai'); // 初始化表单占位符
        refreshSavedApisList();
        $('#apiManagerModal').modal('show');
    });
    
    // 监听API格式选择变化
    $('#apiFormat').on('change', function() {
        updateApiFormPlaceholders($(this).val());
    });
    
    $('#fetchModelsBtn').on('click', async function() {
        const endpoint = $('#apiEndpoint').val().trim();
        const key = $('#apiKey').val().trim();
        const modelUrl = $('#modelEndpoint').val().trim();
        const apiFormat = $('#apiFormat').val();
        
        if (!endpoint || !modelUrl) {
            showError('请先填写 API 端点和模型列表端点');
            return;
        }
        
        try {
            const headers = {'Content-Type':'application/json'};
            if (key) headers['Authorization'] = `Bearer ${key}`;
            const res = await fetch(modelUrl, {method:'GET', headers});
            
            if (!res.ok) throw new Error(res.statusText);
            const data = await res.json();
            
            let models = [];
            if (apiFormat === 'openai') {
                // OpenAI格式处理
                models = Array.isArray(data.data) 
                    ? data.data.map(m => m.id || m.name) 
                    : [];
            } else if (apiFormat === 'edge') {
                // Edge API格式处理
                models = Array.isArray(data) 
                    ? data.map(m => m.ShortName || m.name) 
                    : [];
            }
            
            if (models.length > 0) {
                $('#manualSpeakers').val(models.join(','));
                showInfo(`成功获取到 ${models.length} 个模型`);
            } else {
                showWarning('未找到可用模型，请检查API格式是否正确');
            }
        } catch (e) {
            showError('获取模型失败: ' + e.message);
        }
    });

    $('#customApiForm').on('submit', function(e) {
        e.preventDefault();
        const name = $('#apiName').val().trim();
        const endpoint = $('#apiEndpoint').val().trim();
        if (!name || !endpoint) { showError('API 名称和端点不能为空'); return; }
        const key = $('#apiKey').val().trim();
        const modelEndpoint = $('#modelEndpoint').val().trim();
        const format = $('#apiFormat').val();
        const manual = $('#manualSpeakers').val().split(',').map(s=>s.trim()).filter(Boolean);
        const maxLen = parseInt($('#maxLength').val()) || null;
        const enableSegmentation = $('#enableSegmentation').prop('checked');
        const id = editingApiId || ('custom-' + Date.now());
        customAPIs[id] = { 
            name, endpoint, apiKey:key, modelEndpoint, format, manual, 
            maxLength: maxLen, enableSegmentation 
        };
        localStorage.setItem('customAPIs', JSON.stringify(customAPIs));
        API_CONFIG[id] = { 
            url:endpoint, isCustom:true, apiKey:key, format, manual, 
            maxLength: maxLen, enableSegmentation 
        };
        updateApiOptions();
        refreshSavedApisList();
        $('#customApiForm')[0].reset();
        editingApiId = null;
        showInfo(`自定义API ${editingApiId? '已更新':'已添加'}: ${name}`);
    });

    // 添加导出API配置功能
    $('#exportApisBtn').on('click', function() {
        if (Object.keys(customAPIs).length === 0) {
            showWarning('没有自定义API可导出');
            return;
        }
        
        try {
            // 创建一个包含所有自定义API的JSON
            const exportData = {
                version: '1.0',
                timestamp: new Date().toISOString(),
                apis: customAPIs
            };
            
            const dataStr = JSON.stringify(exportData, null, 2);
            const blob = new Blob([dataStr], {type: 'application/json'});
            const url = URL.createObjectURL(blob);
            
            // 创建下载链接并触发下载
            const a = document.createElement('a');
            a.download = `ciallo-tts-apis-${new Date().toISOString().slice(0,10)}.json`;
            a.href = url;
            a.click();
            
            // 清理URL对象
            setTimeout(() => URL.revokeObjectURL(url), 100);
            
            showInfo(`成功导出 ${Object.keys(customAPIs).length} 个自定义API配置`);
        } catch (error) {
            console.error('导出API失败:', error);
            showError('导出失败: ' + error.message);
        }
    });
    
    // 添加导入API配置功能
    $('#importApisBtn').on('click', function() {
        $('#importApisInput').click();
    });
    
    $('#importApisInput').on('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = function(event) {
            try {
                const data = JSON.parse(event.target.result);
                
                // 验证导入的数据格式
                if (!data.apis || typeof data.apis !== 'object') {
                    throw new Error('无效的API配置文件格式');
                }
                
                // 计算有多少个API将被导入
                const apiCount = Object.keys(data.apis).length;
                
                if (apiCount === 0) {
                    showWarning('导入的文件不包含任何API配置');
                    return;
                }
                
                // 确认导入
                if (confirm(`确定要导入 ${apiCount} 个自定义API配置吗？这将合并与现有配置。`)) {
                    // 合并API配置
                    let importedCount = 0;
                    let updatedCount = 0;
                    
                    Object.entries(data.apis).forEach(([id, api]) => {
                        // 生成新ID，避免覆盖现有配置
                        const newId = id.startsWith('custom-') ? id : 'custom-' + Date.now() + '-' + importedCount;
                        
                        // 检查是否已存在相同名称和端点的API
                        const existingApiId = Object.keys(customAPIs).find(apiId => 
                            customAPIs[apiId].name === api.name && 
                            customAPIs[apiId].endpoint === api.endpoint
                        );
                        
                        if (existingApiId) {
                            // 更新现有API
                            customAPIs[existingApiId] = { ...api };
                            API_CONFIG[existingApiId] = { 
                                url: api.endpoint, 
                                isCustom: true, 
                                apiKey: api.apiKey, 
                                format: api.format, 
                                manual: api.manual,
                                maxLength: api.maxLength 
                            };
                            updatedCount++;
                        } else {
                            // 添加新API
                            customAPIs[newId] = { ...api };
                            API_CONFIG[newId] = { 
                                url: api.endpoint, 
                                isCustom: true, 
                                apiKey: api.apiKey, 
                                format: api.format, 
                                manual: api.manual,
                                maxLength: api.maxLength 
                            };
                            importedCount++;
                        }
                    });
                    
                    // 保存到localStorage
                    localStorage.setItem('customAPIs', JSON.stringify(customAPIs));
                    
                    // 更新UI
                    updateApiOptions();
                    refreshSavedApisList();
                    
                    showInfo(`导入完成: 新增 ${importedCount} 个API, 更新 ${updatedCount} 个API`);
                }
            } catch (error) {
                console.error('导入API失败:', error);
                showError('导入失败: ' + error.message);
            }
            
            // 重置文件输入，允许重复选择同一文件
            this.value = '';
        };
        
        reader.onerror = function() {
            showError('读取文件失败');
        };
        
        reader.readAsText(file);
    });
    
    // 添加批量删除功能
    $('#batchDeleteBtn').on('click', function() {
        $('.api-selection-tools').show();
        $('#batchDeleteBtn').hide();
        $('#exportApisBtn, #importApisBtn').hide();
        
        // 为每个API项添加复选框
        $('#savedApisList .list-group-item').each(function() {
            const apiId = $(this).find('.delete-api').data('api-id');
            
            // 在每个API项前添加复选框
            $(this).prepend(
                `<div class="form-check api-checkbox" style="position:absolute; left:10px; top:50%; transform:translateY(-50%);">
                    <input class="form-check-input api-select" type="checkbox" value="${apiId}">
                </div>`
            );
            
            // 调整布局以适应复选框
            $(this).css('padding-left', '40px').css('position', 'relative');
            
            // 隐藏原有的按钮
            $(this).find('.btn-group').hide();
        });
    });
    
    // 全选功能
    $('#selectAllApis').on('change', function() {
        const isChecked = $(this).prop('checked');
        $('.api-select').prop('checked', isChecked);
    });
    
    // 取消选择
    $('#cancelSelectionBtn').on('click', function() {
        exitBatchDeleteMode();
    });
    
    // 删除选中项
    $('#deleteSelectedBtn').on('click', function() {
        const selectedIds = [];
        $('.api-select:checked').each(function() {
            selectedIds.push($(this).val());
        });
        
        if (selectedIds.length === 0) {
            showWarning('请先选择要删除的API');
            return;
        }
        
        if (confirm(`确定要删除选中的 ${selectedIds.length} 个API吗？`)) {
            selectedIds.forEach(id => {
                delete customAPIs[id];
                delete API_CONFIG[id];
            });
            
            // 更新localStorage
            localStorage.setItem('customAPIs', JSON.stringify(customAPIs));
            
            // 更新UI
            updateApiOptions();
            
            // 如果当前选中的是被删除的API，切换到edge-api
            if (selectedIds.includes($('#api').val())) {
                $('#api').val('edge-api').trigger('change');
            }
            
            showInfo(`已删除 ${selectedIds.length} 个自定义API`);
            
            // 退出批量删除模式
            exitBatchDeleteMode();
            refreshSavedApisList();
        }
    });

    function exitBatchDeleteMode() {
        $('.api-selection-tools').hide();
        $('#batchDeleteBtn').show();
        $('#exportApisBtn, #importApisBtn').show();
        $('.api-checkbox').remove();
        $('#savedApisList .list-group-item').css('padding-left', '').css('position', '');
        $('#savedApisList .list-group-item .btn-group').show();
        $('#selectAllApis').prop('checked', false);
    }

    // 初始API选择变更事件
    $('#api').on('change', function() {
        const apiName = $(this).val();
        updateSpeakerOptions(apiName);
        
        // 根据选择的API更新提示信息
        updateApiTipsText(apiName);
    });
});

// 刷新保存的自定义API列表
function refreshSavedApisList() {
    const listContainer = $('#savedApisList');
    listContainer.empty();
    
    if (Object.keys(customAPIs).length === 0) {
        listContainer.append('<div class="alert alert-light">没有保存的自定义API</div>');
        $('#batchDeleteBtn').hide();
        return;
    } else {
        $('#batchDeleteBtn').show();
    }
    
    Object.keys(customAPIs).forEach(apiId => {
        const api = customAPIs[apiId];
        const item = $(`
            <div class="list-group-item d-flex justify-content-between align-items-center">
                <div>
                    <h6>${api.name}</h6>
                    <div class="d-flex flex-wrap text-muted small">
                        <span class="mr-2"><i class="fas fa-link"></i> ${api.endpoint}</span>
                        ${api.format ? `<span class="mr-2"><i class="fas fa-code"></i> ${api.format === 'openai' ? 'OpenAI' : 'Edge'}</span>` : ''}
                        ${api.manual && api.manual.length ? `<span><i class="fas fa-microphone"></i> ${api.manual.length}个讲述人</span>` : ''}
                    </div>
                </div>
                <div class="btn-group">
                    <button class="btn btn-sm btn-primary edit-api" data-id="${apiId}" title="编辑">
                      <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn btn-sm btn-outline-primary copy-api" data-id="${apiId}" title="复制">
                      <i class="fas fa-clone"></i>
                    </button>
                    <button class="btn btn-sm btn-danger delete-api" data-api-id="${apiId}" title="删除">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `);
        
        listContainer.append(item);
    });
    
    // 添加删除API的事件处理程序
    $('.delete-api').on('click', function() {
        const apiId = $(this).data('api-id');
        deleteCustomApi(apiId);
    });
    
    // 添加编辑API的事件处理程序
    $('.edit-api').on('click', function() {
        const apiId = $(this).data('id');
        const api = customAPIs[apiId];
        editingApiId = apiId;
        $('#apiName').val(api.name);
        $('#apiEndpoint').val(api.endpoint);
        $('#apiKey').val(api.apiKey);
        $('#modelEndpoint').val(api.modelEndpoint);
        $('#apiFormat').val(api.format);
        $('#manualSpeakers').val((api.manual || []).join(','));
        $('#maxLength').val(api.maxLength || '');
        updateApiFormPlaceholders(api.format || 'openai');
    });
    
    // 添加复制API的事件处理程序
    $('.copy-api').on('click', function() {
        const apiId = $(this).data('id');
        const api = customAPIs[apiId];
        
        if (!api) return;
        
        const newId = 'custom-' + Date.now();
        const apiCopy = {...api};
        apiCopy.name = `${api.name} (复制)`;
        
        customAPIs[newId] = apiCopy;
        API_CONFIG[newId] = { 
            url: apiCopy.endpoint, 
            isCustom: true, 
            apiKey: apiCopy.apiKey, 
            format: apiCopy.format, 
            manual: apiCopy.manual,
            maxLength: apiCopy.maxLength 
        };
        
        // 保存到localStorage
        localStorage.setItem('customAPIs', JSON.stringify(customAPIs));
        
        // 更新UI
        updateApiOptions();
        refreshSavedApisList();
        showInfo(`已复制API: ${apiCopy.name}`);
    });
}

// 更新字符计数提示文本
function updateCharCountText() {
    const currentLength = getTextLength($('#text').val());
    const apiName = $('#api').val();
    const { maxTotal } = getApiLimits(apiName);
    const percentage = Math.round((currentLength / maxTotal) * 100);
    
    $('#charCount').text(`${percentage}% (${currentLength}/${maxTotal}单位)`);
    $('#text').attr('maxlength', maxTotal);
    
    // 如果超过100%，阻止继续输入
    if (currentLength > maxTotal) {
        const textarea = $('#text')[0];
        let text = textarea.value;
        // 截断文本直到符合长度限制
        while (getTextLength(text) > maxTotal && text.length > 0) {
            text = text.slice(0, -1);
        }
        textarea.value = text;
        $('#charCount').text(`100% (${getTextLength(text)}/${maxTotal}单位)`);
    }
}

function canMakeRequest() {
    if (isGenerating) {
        showError('请等待当前语音生成完成');
        return false;
    }
    return true;
}

async function generateVoice(isPreview, autoPlay = false) {
    const apiName = $('#api').val();
    const apiUrl = API_CONFIG[apiName].url;
    const rawText = $('#text').val().trim();
    const text = stripMarkdown(rawText);
    // 在开始生成时保存当前选择的讲述人名称
    const currentSpeakerText = $('#speaker option:selected').text();
    // 保存当前选择的讲述人ID，用于后续所有分段请求
    const currentSpeakerId = $('#speaker').val();
    
    if (!text) {
        showError('请输入要转换的文本');
        return;
    }

    if (isPreview) {
        const previewText = text.substring(0, 20);
        try {
            const blob = await makeRequest(apiUrl, true, previewText, '', currentSpeakerId);
            if (blob) {
                if (currentAudioURL) URL.revokeObjectURL(currentAudioURL);
                currentAudioURL = URL.createObjectURL(blob);
                $('#result').show();
                $('#audio').attr('src', currentAudioURL);
                $('#download').attr('href', currentAudioURL);
            }
        } catch (error) {
            showError('试听失败：' + error.message);
        } finally {
            // Use existing loading toast hide instead of overlay
        }
        return;
    }

    if (!canMakeRequest()) {
        return;
    }

    // 如果是"生成并播放"，将按钮切换为"停止"状态（不禁用，便于随时停止）
    if (autoPlay) {
        const $btn = $('#playButton');
        if (!$btn.data('origHtml')) {
            $btn.data('origHtml', $btn.html());
        }
        $btn.html('<i class="fas fa-stop mr-2"></i>停止');
        $btn.prop('disabled', false);
    }

    // 设置生成状态
    cancelRequested = false;
    isGenerating = true;
    $('#generateButton').prop('disabled', true);
    $('#previewButton').prop('disabled', true);

    // 处理长文本（基于清理后的文本分段）
    const segments = splitText(text);
    requestCounter++;
    const currentRequestId = requestCounter;
    
    if (segments.length > 1) {
        isLongTextGenerating = true;
        // 启用分段顺序播放模式
        queueModeActive = !!autoPlay;
        playbackQueue = [];
        isQueuePlaying = false;
        showLoading(`正在生成#${currentRequestId}请求的 1/${segments.length} 段语音...`);
        generateVoiceForLongText(segments, currentRequestId, currentSpeakerText, currentSpeakerId, apiUrl, apiName, autoPlay).finally(() => {
            hideLoading();
            isGenerating = false;  // 重置生成状态
            $('#generateButton').prop('disabled', false);
            $('#previewButton').prop('disabled', false);
            // 恢复"生成并播放"按钮
            if (autoPlay) {
                const $btn = $('#playButton');
                const orig = $btn.data('origHtml');
                $btn.html(orig || '<i class="fas fa-play-circle mr-2"></i>生成并播放');
                $btn.prop('disabled', false);
            }
            currentAbortController = null;
            queueModeActive = false;
            isLongTextGenerating = false;
        });
    } else {
        showLoading(`正在生成#${currentRequestId}请求的语音...`);
        const requestInfo = `#${currentRequestId}(1/1)`;
        makeRequest(apiUrl, false, text, requestInfo, currentSpeakerId)
            .then(blob => {
                if (blob) {
                    const timestamp = new Date().toLocaleTimeString();
                    // 使用保存的讲述人名称，而不是重新获取
                    const cleanTextForHistory = text.replace(/<break\s+time=["'](\d+(?:\.\d+)?[ms]s?)["']\s*\/>/g, '');
                    const shortenedText = cleanTextForHistory.length > 7 ? cleanTextForHistory.substring(0, 7) + '...' : cleanTextForHistory;
                    addHistoryItem(timestamp, currentSpeakerText, shortenedText, blob, requestInfo);
                    if (autoPlay) {
                        const audioEl = $('#audio')[0];
                        if (audioEl) {
                            audioEl.currentTime = 0;
                            audioEl.play().catch(() => {
                                showInfo('音频已生成，若未自动播放请点击播放器播放');
                            });
                        }
                    }
                }
            })
            .finally(() => {
                hideLoading();
                isGenerating = false;  // 重置生成状态
                $('#generateButton').prop('disabled', false);
                $('#previewButton').prop('disabled', false);
                // 恢复"生成并播放"按钮
                if (autoPlay) {
                    const $btn = $('#playButton');
                    const orig = $btn.data('origHtml');
                    $btn.html(orig || '<i class="fas fa-play-circle mr-2"></i>生成并播放');
                    $btn.prop('disabled', false);
                }
                currentAbortController = null;
            });
    }
}

const cachedAudio = new Map();

function escapeXml(text) {
    // 临时替换 SSML 标签
    const ssmlTags = [];
    let tempText = text.replace(/<break\s+time=["'](\d+(?:\.\d+)?[ms]s?)["']\s*\/>/g, (match) => {
        ssmlTags.push(match);
        return `__SSML_TAG_${ssmlTags.length - 1}__`;
    });

    // 转义其他特殊字符
    tempText = tempText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    // 还原 SSML 标签
    tempText = tempText.replace(/__SSML_TAG_(\d+)__/g, (_, index) => ssmlTags[parseInt(index)]);

    return tempText;
}

async function makeRequest(url, isPreview, text, requestInfo = '', speakerId = null) {
    try {
        // 每次请求创建新的 AbortController，以支持中止
        currentAbortController = new AbortController();
        const signal = currentAbortController.signal;
        // 获取当前API类型
        const apiName = $('#api').val();
        const customApi = customAPIs[apiName];
        const isCustomApi = !!customApi;
        // Azure TTS 1 使用 azure-ssml 格式，其他自定义 API 如果没指定格式则默认为 openai
        const apiFormat = customApi ? (customApi.format || 'openai') : (API_CONFIG[apiName]?.format || 'edge');

        // 如果是自定义OpenAI格式API，移除所有的停顿标签
        if (apiFormat === 'openai') {
            text = text.replace(/<break\s+time=["'](\d+(?:\.\d+)?[ms]s?)["']\s*\/>/g, '');
            
            // 对OAI格式API添加文本长度验证 - 修改长度限制逻辑
            const textLength = getTextLength(text);
            const maxSegmentLength = customApi?.maxLength || 1000;
            const maxTotalLength = customApi?.maxLength ? customApi.maxLength * 5 : 5000;
            
            // 检查总长度限制
            if (textLength > maxTotalLength) {
                throw new Error(`OpenAI格式API文本总长度超限，最多支持${maxTotalLength}个单位，当前长度: ${textLength}`);
            }
            
            // 检查单段长度限制（用于非预览请求）
            if (!isPreview && textLength > maxSegmentLength) {
                // 这里不抛错，让分段逻辑处理
                console.log(`文本将被分段处理，单段限制: ${maxSegmentLength}个单位`);
            }
        } else {
            // 转义文本中的特殊字符，但保护 SSML 标签
            text = escapeXml(text);
        }
        
        const headers = {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json'
        };
        
        // 使用传入的speakerId（如果有）或者当前选择的speakerId
        const voice = speakerId || $('#speaker').val();
        
        let requestBody;
        let requestUrl = url;
        
        // 根据不同的API创建不同的请求体
        if (apiFormat === 'openai') {
            const instructions = $('#instructions').val().trim();
            const format = $('#audioFormat').val();

            requestBody = {
                model: voice, // 对于OpenAI格式API，voice是model
                input: text,
                voice: isCustomApi ? "alloy" : voice, // 自定义API使用模型ID作为model参数，voice参数设置为默认值
                response_format: format
            };

            // 只有当instructions不为空时才添加到请求体中
            if (instructions) {
                requestBody.instructions = instructions;
            }

            // 如果是自定义API且有apiKey，添加Authorization头
            if (isCustomApi && customApi.apiKey) {
                headers['Authorization'] = `Bearer ${customApi.apiKey}`;
            }
        } else if (apiFormat === 'azure-ssml') {
             // Azure TTS 使用 SSML，直接发送给后端转发
             const rateVal = parseInt($('#rate').val()) || 0;
             const pitchVal = parseInt($('#pitch').val()) || 0;
             const rate = rateVal >= 0 ? `+${rateVal}%` : `${rateVal}%`;
             const pitch = pitchVal >= 0 ? `+${pitchVal}%` : `${pitchVal}%`;

             requestBody = `<speak version='1.0' xml:lang='en-US'><voice xml:lang='en-US' xml:gender='Female' name='${voice}'><prosody rate='${rate}' pitch='${pitch}'>${text}</prosody></voice></speak>`;
             // 后端转发需要 SSML body
             headers['Content-Type'] = 'application/ssml+xml';
             // 不需要在前端设置 Key，Key 在后端环境变量中
        } else {
            requestBody = {
                text: text,
                voice: voice,
                rate: parseInt($('#rate').val()),
                pitch: parseInt($('#pitch').val()),
                preview: isPreview
            };
            
        // 如果是自定义Edge格式API且有apiKey
        if (isCustomApi && customApi.apiKey) {
            const key = customApi.apiKey;
            // 检查是否是x-api-key格式
            if (key.toLowerCase().startsWith('x-api-key:')) {
                const keyValue = key.substring('x-api-key:'.length).trim();
                headers['Ocp-Apim-Subscription-Key'] = keyValue;
            } else {
                // Azure TTS 通常使用 Ocp-Apim-Subscription-Key
                headers['Ocp-Apim-Subscription-Key'] = key;
            }
            // 自定义 Azure/Edge API 可能需要此头
            headers['X-Microsoft-OutputFormat'] = "audio-24khz-48kbitrate-mono-mp3";
        }
        }

        console.log('发送请求到:', requestUrl);

        const bodyContent = (typeof requestBody === 'string') ? requestBody : JSON.stringify(requestBody);

        if (!isCustomApi) {
            requireBackendBaseUrl();
        }

        let response;
        try {
            response = await fetch(requestUrl, {
                method: 'POST',
                headers: headers,
                body: bodyContent,
                signal
            });

            console.log('Fetch 已完成加载：' + response.status);

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                console.error('服务器响应错误:', response.status, response.statusText, errorText);
                throw new Error(`服务器响应错误: ${response.status} - ${errorText || response.statusText}`);
            }
        } catch (fetchError) {
            // Edge API 失败时自动回退到 Azure TTS
            if (apiName === 'edge-api' && API_CONFIG['azure-tts-1'] && fetchError.name !== 'AbortError') {
                console.warn('Edge API 失败，自动回退到 Azure TTS:', fetchError.message);
                showInfo('Edge API 请求失败，自动切换到 Azure TTS...');

                const voice = speakerId || $('#speaker').val();
                const rateVal = parseInt($('#rate').val()) || 0;
                const pitchVal = parseInt($('#pitch').val()) || 0;
                const azureRate = rateVal >= 0 ? `+${rateVal}%` : `${rateVal}%`;
                const azurePitch = pitchVal >= 0 ? `+${pitchVal}%` : `${pitchVal}%`;
                const ssml = `<speak version='1.0' xml:lang='en-US'><voice xml:lang='en-US' xml:gender='Female' name='${voice}'><prosody rate='${azureRate}' pitch='${azurePitch}'>${text}</prosody></voice></speak>`;

                response = await fetch(getBaseUrl() + '/api/azure-tts', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/ssml+xml',
                        'Accept': 'audio/mpeg',
                    },
                    body: ssml,
                    signal
                });

                if (!response.ok) {
                    const errorText = await response.text().catch(() => '');
                    throw new Error(`Edge API 和 Azure TTS 均请求失败: ${errorText || response.statusText}`);
                }
                console.log('Azure TTS 回退成功');
            } else {
                if (fetchError instanceof TypeError && fetchError.message === 'Failed to fetch') {
                    throw new Error('请求云端后台失败，请检查“云端后台设置”的地址是否正确、是否包含 https://，以及服务器是否允许跨域访问。');
                }
                throw fetchError;
            }
        }

        const blob = await response.blob();
        
        // 验证返回的blob是否为有效的音频文件
        if (!blob.type.includes('audio/') || blob.size === 0) {
            throw new Error('无效的音频文件');
        }

        if (!isPreview) {
            // 在分段顺序播放模式下，不要立即切换播放器音源，避免打断当前播放
            if (!queueModeActive) {
                currentAudioURL = URL.createObjectURL(blob);
                $('#result').show();
                $('#audio').attr('src', currentAudioURL);
                $('#download')
                    .removeClass('disabled')
                    .attr('href', currentAudioURL);
                // 设置下载文件名
                const audioFormat = (apiFormat === 'openai') ? $('#audioFormat').val() : 'mp3';
                $('#download').attr('download', `voice.${audioFormat}`);
            }
            // 仅在非长文本场景或长文本已合并完成时，才持久化最后音频
            if (!isLongTextGenerating) {
                persistAudio(blob);
            }
        }

        return blob;
    } catch (error) {
            console.error('请求错误:', error);
            showError(error.message);
            throw error;
    }
}

function showError(message) {
    showMessage(message, 'danger');
}

function addHistoryItem(timestamp, speaker, text, audioBlob, requestInfo = '') {
    const MAX_HISTORY = 50;
    const historyItems = $('#historyItems');
    
    if (historyItems.children().length >= MAX_HISTORY) {
        const oldestItem = historyItems.children().last();
        oldestItem.remove();
    }

    const audioURL = URL.createObjectURL(audioBlob);
    cachedAudio.set(audioURL, audioBlob);
    
    // 清理文本中的 SSML 标签
    const cleanText = text.replace(/<break\s+time=["'](\d+(?:\.\d+)?[ms]s?)["']\s*\/>/g, '');
    
    const historyItem = $(`
        <div class="history-item list-group-item" style="opacity: 0;">
            <div class="d-flex justify-content-between align-items-center">
                <span class="text-truncate me-2" style="max-width: 70%;">
                    <strong class="text-primary">${requestInfo}</strong> 
                    ${timestamp} - <span class="text-primary">${speaker}</span> - ${cleanText}
                </span>
                <div class="btn-group flex-shrink-0">
                    <button class="btn btn-sm btn-outline-primary play-btn" data-url="${audioURL}">
                        <i class="fas fa-play"></i>
                    </button>
                    <button class="btn btn-sm btn-outline-success" onclick="downloadAudio('${audioURL}')">
                        <i class="fas fa-download"></i>
                    </button>
                </div>
            </div>
        </div>
    `);
    
    // 添加整个条目的点击事件
    historyItem.on('click', function(e) {
        // 如果点击的是按钮，不触发条目的点击事件
        if (!$(e.target).closest('.btn-group').length) {
            playAudio(audioURL);
            // 更新预览区
            if (currentAudioURL) {
                URL.revokeObjectURL(currentAudioURL);
            }
            currentAudioURL = URL.createObjectURL(cachedAudio.get(audioURL));
            $('#result').show();
            $('#audio').attr('src', currentAudioURL);
            $('#download')
                .removeClass('disabled')
                .attr('href', currentAudioURL);
        }
    });
    
    // 在条目被移除时清理资源
    historyItem.on('remove', () => {
        URL.revokeObjectURL(audioURL);
        cachedAudio.delete(audioURL);
    });
    
    historyItem.find('.play-btn').on('click', function(e) {
        e.stopPropagation();  // 阻止事件冒泡
        playAudio($(this).data('url'));
    });
    
    $('#historyItems').prepend(historyItem);
    setTimeout(() => historyItem.animate({ opacity: 1 }, 300), 50);
}

function playAudio(audioURL) {
    const audioElement = $('#audio')[0];
    const allPlayButtons = $('.play-btn');
    
    // 如果点击的是当前正在播放的音频
    if (audioElement.src === audioURL && !audioElement.paused) {
        audioElement.pause();
        allPlayButtons.each(function() {
            if ($(this).data('url') === audioURL) {
                $(this).html('<i class="fas fa-play"></i>');
            }
        });
        return;
    }
    
    // 重置所有按钮标
    allPlayButtons.html('<i class="fas fa-play"></i>');
    
    // 设置新的音频源并播放
    audioElement.src = audioURL;
    audioElement.load();
    
    // 只在实际播放时才设置错误处理
    audioElement.play().then(() => {
        // 更新当前播放按钮图标
        allPlayButtons.each(function() {
            if ($(this).data('url') === audioURL) {
                $(this).html('<i class="fas fa-pause"></i>');
            }
        });
    }).catch(error => {
        if (error.name !== 'AbortError') {  // 忽略中止错误
            console.error('播放失败:', error);
            showError('音频播放失败，请重试');
        }
    });
    
    // 监听播放结束事件 - 只有在非队列模式时才设置
    if (!queueModeActive) {
        audioElement.onended = function() {
            // 重置播放按钮状态
            allPlayButtons.each(function() {
                if ($(this).data('url') === audioURL) {
                    $(this).html('<i class="fas fa-play"></i>');
                }
            });
        };
    }
}

// 依次播放队列中的音频URL
function playQueueNext() {
    if (cancelRequested) {
        // 清空队列
        playbackQueue.forEach(url => URL.revokeObjectURL(url));
        playbackQueue = [];
        isQueuePlaying = false;
        return;
    }
    const audioEl = $('#audio')[0];
    if (!audioEl) return;
    // 如果当前仍在播放且未结束，保持播放不中断
    if (!audioEl.paused && !audioEl.ended) {
        return;
    }
    const next = playbackQueue.shift();
    if (!next) {
        isQueuePlaying = false;
        return;
    }

    isQueuePlaying = true;
    $('#result').show();
    audioEl.src = next;
    audioEl.load();

    // 在队列模式下，注册结束事件以继续播放下一段
    audioEl.onended = function() {
        if (queueModeActive && playbackQueue.length > 0) {
            playQueueNext();
        } else {
            isQueuePlaying = false;
        }
    };

    // 播放音频
    audioEl.play().then(() => {
        console.log('队列音频播放开始');
    }).catch((error) => {
        console.warn('队列播放失败:', error);
        // 即使播放失败，也尝试继续下一段
        if (queueModeActive && playbackQueue.length > 0) {
            playQueueNext();
        } else {
            isQueuePlaying = false;
        }
    });
}

function downloadAudio(audioURL) {
    const blob = cachedAudio.get(audioURL);
    if (blob) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'audio.mp3';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
    }
}

function clearHistory() {
    $('#historyItems .history-item').each(function() {
        $(this).remove();
    });
    
    // 清理所有缓存的音频
    cachedAudio.forEach((blob, url) => {
        URL.revokeObjectURL(url);
    });
    cachedAudio.clear();
    
    $('#historyItems').empty();
    alert("历史记录已清除！");
}

function initializeAudioPlayer() {
    const audio = document.getElementById('audio');
    audio.style.borderRadius = '12px';
    audio.style.width = '100%';
    audio.style.marginTop = '20px';
    
    // 初始状态设置
    $('#download')
        .addClass('disabled')
        .attr('href', '#');
    $('#audio').attr('src', '');
}

function showMessage(message, type = 'danger') {
    const toast = $(`
        <div class="toast">
            <div class="toast-body toast-${type}">
                ${message}
            </div>
        </div>
    `);
    
    $('.toast-container').append(toast);
    
    // 显示动画
    setTimeout(() => {
        toast.addClass('show');
    }, 100);
    
    // 3秒后淡出并移除
    setTimeout(() => {
        toast.removeClass('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// 添加句子结束符号的正则表达式
const SENTENCE_ENDINGS = /[.。！!?？]/;
const PARAGRAPH_ENDINGS = /[\n\r]/;

function getTextLength(str) {
    // 移除 XML 标签，但记录停顿时间
    let totalPauseTime = 0;
    const textWithoutTags = str.replace(/<break\s+time="(\d+(?:\.\d+)?)(m?s)"\s*\/>/g, (match, time, unit) => {
        const seconds = unit === 'ms' ? parseFloat(time) / 1000 : parseFloat(time);
        totalPauseTime += seconds;
        return '';
    });

    // 计算文本长度（中文2字符，英文1字符）
    const textLength = textWithoutTags.split('').reduce((acc, char) => {
        return acc + (char.charCodeAt(0) > 127 ? 2 : 1);
    }, 0);

    // 将停顿时间转换为等效字符长度（1秒 = 11个单位，相当于5.5个中文字符）
    const pauseLength = Math.round(totalPauseTime * 11);

    return textLength + pauseLength;
}

// 返回每个API的最大段长和总长
function getApiLimits(apiName) {
    // returns { maxSegment, maxTotal } for each API
    if (customAPIs[apiName] && customAPIs[apiName].format === 'openai') {
        return { maxSegment: 400, maxTotal: 2000 };
    } else {
        return { maxSegment: 5000, maxTotal: 100000 };
    }
}

function splitText(text) {
    const apiName = $('#api').val();
    const { maxSegment } = getApiLimits(apiName);
    const segments = [];
    let remainingText = text.trim();

     const punctuationGroups = [
        // 第一优先级: 换行符
        ['\n', '\r\n'],  
        
        // 第二优先级: 句末标点
        [
            '。', '！', '？',           // 中文
            '.', '!', '?',            // 英文
            '。', '！', '？',           // 日文
            '︒', '︕', '︖',           // 全角
            '｡', '!', '?',            // 半角/阿拉伯文
            '。', '॥',                 // 梵文
            '؟', '۔',                 // 阿拉伯文
            '។', '៕',                 // 高棉文
            '။', '၏',                 // 缅甸文
            '¿', '¡',                 // 西班牙文
            '‼', '⁇', '⁈', '⁉',      // 组合标点
            '‽','~'                       // 叹问号
        ],
        
        // 第三优先级: 分号
        [
            '；', ';',                // 中英文
            '；',                     // 日文
            '︔', '︐',               // 全角
            '؛',                     // 阿拉伯文
            '፤',                     // 埃塞俄比亚文
            '꛶'                      // 巴姆穆文
        ],
        
        // 第四优先级: 逗号和冒号
        [
            '，', '：',               // 中文
            ',', ':',                // 英文
            '、', '，', '：',         // 日文
            '︑', '︓',              // 全角
            '､', ':', '、',          // 半角/阿拉伯文
            '፣', '፥',               // 埃塞俄比亚文
            '၊', '၌',               // 缅甸文
            '、', '؍',               // 波斯文
            '׀', '，'                // 希伯来文
        ],
        
        // 第五优先级: 其他标点
        [
            '、', '…', '―', '─',     // 中文破折号
            '-', '—', '–',           // 英文破折号
            '‥', '〳', '〴', '〵',   // 日文重复符号
            '᠁', '᠂', '᠃',          // 蒙古文
            '᭛', '᭜', '᭝'          // 巴厘文
        ],
        
        // 第六优先级: 空格和其他分隔符
        [
            ' ', '\t',              // 空格和制表符
            '　',                    // 全角空格
            '〿', '〮', '〯',        // 其他分隔符
            '᠀',                    // 蒙古文分隔符
            '᭟', '᭠',              // 巴厘文分隔符
            '᳓', '᳔', '᳕'          // 韵律标记
        ]
    ];

    while (remainingText.length > 0) {
        let splitIndex = remainingText.length;
        let currentLength = 0;
        let bestSplitIndex = -1;
        let bestPriorityFound = -1;

        for (let i = 0; i < remainingText.length; i++) {
            currentLength += remainingText.charCodeAt(i) > 127 ? 2 : 1;
            
            if (currentLength > maxSegment) {
                splitIndex = i;
                // 先遍历优先级组
                for (let priority = 0; priority < punctuationGroups.length; priority++) {
                    let searchLength = 0;
                    // 在300单位范围内搜索当前优先级的标点
                    for (let j = i; j >= 0 && searchLength <= 300; j--) {
                        searchLength += remainingText.charCodeAt(j) > 127 ? 2 : 1;
                        
                        if (punctuationGroups[priority].includes(remainingText[j])) {
                            // 找到当前优先级的分段点，记录位置并停止搜索
                            bestPriorityFound = priority;
                            bestSplitIndex = j;
                            break;
                        }
                    }
                    // 如果在当前优先级找到了分段点，就不再检查更低优先级
                    if (bestSplitIndex > -1) break;
                }
                break;
            }
        }

        if (bestSplitIndex > 0) {
            splitIndex = bestSplitIndex + 1;
        }

        segments.push(remainingText.substring(0, splitIndex));
        remainingText = remainingText.substring(splitIndex).trim();
    }

    return segments;
}

function showLoading(message) {
    let loadingToast = $('.toast-loading');
    if (loadingToast.length) {
        // 如果已存在 loading toast，只更新进度条，不更新消息
        loadingToast.find('.progress-bar').css('width', '0%');
        return;
    }

    // 创建新的loading提示
    const toast = $(`
        <div class="toast toast-loading">
            <div class="toast-body toast-info">
                <div class="text-center">
                    <i class="fas fa-spinner fa-spin"></i>
                    <div class="loading-message mt-2">${message}</div>
                    <div class="progress mt-2">
                        <div class="progress-bar" role="progressbar" style="width: 0%"></div>
                    </div>
                </div>
            </div>
        </div>
    `);
    
    $('.toast-container').append(toast);
    setTimeout(() => toast.addClass('show'), 100);
}

function hideLoading() {
    const loadingToast = $('.toast-loading');
    loadingToast.removeClass('show');
    setTimeout(() => loadingToast.remove(), 300);
}

function updateLoadingProgress(progress, message) {
    const loadingToast = $('.toast-loading');
    if (loadingToast.length) {
        loadingToast.find('.progress-bar').css('width', `${progress}%`);
        loadingToast.find('.loading-message').text(message);
    }
}

async function generateVoiceForLongText(segments, currentRequestId, currentSpeakerText, currentSpeakerId, apiUrl, apiName, autoPlay = false) {
    const results = [];
    const totalSegments = segments.length;
    
    // 获取原始文本，先去除Markdown/链接，再清理 SSML 标签，用于合并后的历史展示
    const originalText = $('#text').val();
    const cleanForTTS = stripMarkdown(originalText);
    const cleanText = cleanForTTS.replace(/<break\s+time=["'](\d+(?:\.\d+)?[ms]s?)["']\s*\/>/g, '');
    const shortenedText = cleanText.length > 7 ? cleanText.substring(0, 7) + '...' : cleanText;
    
    showLoading('');
    
    let hasSuccessfulSegment = false;
    const MAX_RETRIES = 3;

    for (let i = 0; i < segments.length; i++) {
        if (cancelRequested) {
            console.warn('用户取消生成');
            break;
        }
        let retryCount = 0;
        let success = false;
        let lastError = null;

        while (retryCount < MAX_RETRIES && !success) {
            try {
                const progress = ((i + 1) / totalSegments * 100).toFixed(1);
                const retryInfo = retryCount > 0 ? `(重试 ${retryCount}/${MAX_RETRIES})` : '';
                updateLoadingProgress(
                    progress, 
                    `正在生成#${currentRequestId}请求的 ${i + 1}/${totalSegments} 段语音${retryInfo}...`
                );
                
                // 为自定义API (format=openai) 使用相同的instructions
                let instructions = null;
                if (customAPIs[apiName] && customAPIs[apiName].format === 'openai') {
                    instructions = $('#instructions').val().trim();
                }
                
                const requestInfo = `#${currentRequestId}(${i + 1}/${totalSegments})`;
                
                const blob = await makeRequest(
                    apiUrl, 
                    false, 
                    segments[i], 
                    requestInfo,  // 传递requestInfo而不是把它用作voice参数
                    currentSpeakerId  // 确保这是正确的speaker ID
                );
                
                if (blob) {
                    hasSuccessfulSegment = true;
                    success = true;
                    results.push(blob);
                    const timestamp = new Date().toLocaleTimeString();
                    // 使用传入的讲述人名称，而不是重新获取
                    const cleanSegmentText = segments[i].replace(/<break\s+time=["'](\d+(?:\.\d+)?[ms]s?)["']\s*\/>/g, '');
                    const shortenedSegmentText = cleanSegmentText.length > 7 ? cleanSegmentText.substring(0, 7) + '...' : cleanSegmentText;
                    const requestInfo = `#${currentRequestId}(${i + 1}/${totalSegments})`;
                    addHistoryItem(timestamp, currentSpeakerText, shortenedSegmentText, blob, requestInfo);

                    // 若启用自动播放，按段落依次播放
                    if (autoPlay && queueModeActive && !cancelRequested) {
                        const audioURL = URL.createObjectURL(blob);
                        playbackQueue.push(audioURL);
                        // 如果音频仍在播放，则不打断；在 onended 或下一次检查时接续
                        if (!isQueuePlaying) {
                            playQueueNext();
                        }
                    }
                }
            } catch (error) {
                lastError = error;
                retryCount++;
                
                if (retryCount < MAX_RETRIES) {
                    console.error(`分段 ${i + 1} 生成失败 (重试 ${retryCount}/${MAX_RETRIES}):`, error);
                    const waitTime = 3000 + (retryCount * 2000);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                } else {
                    showError(`第 ${i + 1}/${totalSegments} 段生成失败：${error.message}`);
                }
            }
        }

        if (!success) {
            console.error(`分段 ${i + 1} 在 ${MAX_RETRIES} 次尝试后仍然失败:`, lastError);
        }

        if (!cancelRequested && success && i < segments.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }

    hideLoading();

    if (results.length > 0) {
        // 合并整段用于下载与持久化
        const finalBlob = new Blob(results, { type: 'audio/mpeg' });
        const timestamp = new Date().toLocaleTimeString();
        const mergeRequestInfo = `#${currentRequestId}(合并)`;
        addHistoryItem(timestamp, currentSpeakerText, shortenedText, finalBlob, mergeRequestInfo);
        // 在长文本合并完成后持久化整体音频，供下次恢复
        persistAudio(finalBlob);

        // 更新播放器为合成的完整音频
        if (autoPlay) {
            // 停止当前队列播放
            queueModeActive = false;
            isQueuePlaying = false;

            // 清理播放队列
            playbackQueue.forEach(url => URL.revokeObjectURL(url));
            playbackQueue = [];

            // 获取当前播放位置
            const audioEl = $('#audio')[0];
            const currentTime = audioEl ? audioEl.currentTime : 0;
            const wasPlaying = audioEl ? !audioEl.paused : false;

            // 更新播放器音频源
            if (currentAudioURL) URL.revokeObjectURL(currentAudioURL);
            currentAudioURL = URL.createObjectURL(finalBlob);
            $('#result').show();
            $('#audio').attr('src', currentAudioURL);
            $('#download').removeClass('disabled').attr('href', currentAudioURL);

            // 设置下载文件名
            const apiFormat = (API_CONFIG[apiName] && API_CONFIG[apiName].format === 'openai') ? $('#audioFormat').val() : 'mp3';
            $('#download').attr('download', `voice.${apiFormat}`);

            // 等待音频加载完成后恢复播放位置并继续播放
            if (audioEl) {
                audioEl.onloadedmetadata = function() {
                    // 恢复播放位置
                    if (currentTime > 0 && currentTime < audioEl.duration) {
                        audioEl.currentTime = currentTime;
                    }

                    // 如果之前正在播放，继续播放
                    if (wasPlaying) {
                        audioEl.play().catch(() => {
                            showInfo('完整音频已生成，若未自动播放请点击播放器播放');
                        });
                    }
                    
                    audioEl.onloadedmetadata = null;
                };
            }

            showInfo('所有段落生成完成，音频已更新为完整版本');
        }

        return finalBlob;
    }

    if (cancelRequested) {
        throw new Error('已停止生成');
    }
    throw new Error('所有片段生成失败');
}

// 在 body 末尾添加 toast 容器
$('body').append('<div class="toast-container"></div>');

// 可以添加其他类型的消息提示
function showWarning(message) {
    showMessage(message, 'warning');
}

function showInfo(message) {
    showMessage(message, 'info');
}

// 可以添加其他类型的消息提示
function showWarning(message) {
    showMessage(message, 'warning');
}

function showInfo(message) {
    showMessage(message, 'info');
}

// 根据选择的API格式更新表单占位符
function updateApiFormPlaceholders(format) {
    if (format === 'openai') {
        $('#apiEndpoint').attr('placeholder', 'https://api.openai.com/v1/audio/speech');
        $('#modelEndpoint').attr('placeholder', 'https://api.openai.com/v1/models');
        $('#apiKey').attr('placeholder', 'sk-...');
        $('#manualSpeakers').attr('placeholder', 'tts-1,tts-1-hd,alloy,echo,fable,onyx,nova,shimmer');
    } else if (format === 'edge') {
        $('#apiEndpoint').attr('placeholder', 'https://api.example.com/api/tts');
        $('#modelEndpoint').attr('placeholder', 'https://api.example.com/api/voices');
        $('#apiKey').attr('placeholder', 'x-api-key: ...');
        $('#manualSpeakers').attr('placeholder', 'zh-CN-XiaoxiaoNeural,en-US-AriaNeural,...');
    }

    // Set default values only when creating a new API (editingApiId is null)
    if (editingApiId === null) {
        if (format === 'openai') {
            $('#apiEndpoint').val('https://api.openai.com/v1/audio/speech');
            $('#modelEndpoint').val('https://api.openai.com/v1/models');
        } else {
            // For Edge or other formats, clear these fields or set to a generic example if desired
            // For now, clearing them is consistent with form.reset() behavior for other fields
            $('#apiEndpoint').val('');
            $('#modelEndpoint').val('');
        }
        // Other fields like apiName, apiKey, manualSpeakers, maxLength are reset by form.reset()
        // or explicitly cleared when the modal is opened for a new API.
    }
}

// 添加删除自定义API的函数
function deleteCustomApi(apiId) {
    if (!customAPIs[apiId]) {
        showError('找不到要删除的API');
        return;
    }
    
    const apiName = customAPIs[apiId].name;
    
    if (confirm(`确定要删除自定义API「${apiName}」吗？`)) {
        // 删除自定义API
        delete customAPIs[apiId];
        delete API_CONFIG[apiId];
        
        // 保存到localStorage
        localStorage.setItem('customAPIs', JSON.stringify(customAPIs));
        
        // 更新API选项
        updateApiOptions();
        
        // 如果当前选中的是被删除的API，切换到edge-api
        if ($('#api').val() === apiId) {
            $('#api').val('edge-api').trigger('change');
        }
        
        // 刷新API列表
        refreshSavedApisList();
        
        showInfo(`已删除API: ${apiName}`);
    }
}