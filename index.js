/**
 * Inline Image Generation Extension for SillyTavern
 *
 * Catches [IMG:GEN:{json}] tags in AI messages and generates images via configured API.
 * Supports OpenAI-compatible and Gemini-compatible (nano-banana) endpoints.
 *
 * v2.3: Wardrobe clothing descriptions (manual + AI-generated via vision model),
 *        injection of clothing descriptions into text model prompt
 */

const MODULE_NAME = 'inline_image_gen';

const processingMessages = new Set();

const logBuffer = [];
const MAX_LOG_ENTRIES = 200;

function iigLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const entry = `[${timestamp}] [${level}] ${message}`;
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();
    if (level === 'ERROR') console.error('[IIG]', ...args);
    else if (level === 'WARN') console.warn('[IIG]', ...args);
    else console.log('[IIG]', ...args);
}

function exportLogs() {
    const logsText = logBuffer.join('\n');
    const blob = new Blob([logsText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iig-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success('Логи экспортированы', 'Генерация картинок');
}

// Default settings
const defaultSettings = Object.freeze({
    enabled: true,
    apiType: 'openai',
    endpoint: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    quality: 'standard',
    maxRetries: 0,
    retryDelay: 1000,
    sendCharAvatar: false,
    sendUserAvatar: false,
    userAvatarFile: '',
    aspectRatio: '1:1',
    imageSize: '1K',
    positivePrompt: '',
    negativePrompt: '',
    fixedStyle: '',
    fixedStyleEnabled: false,
    extractAppearance: true,
    extractUserAppearance: true,
    detectClothing: true,
    clothingSearchDepth: 5,
    npcList: [],
    autoDetectNames: true,
    // v2.2: Wardrobe
    wardrobeItems: [],
    activeWardrobeChar: null,
    activeWardrobeUser: null,
    // v2.2: Collapsible section states
    collapsedSections: {},
    // v2.3: Wardrobe descriptions
    wardrobeDescEndpoint: '',
    wardrobeDescApiKey: '',
    wardrobeDescModel: '',
    injectWardrobeToChat: true,
    wardrobeInjectionDepth: 1,
    wardrobeDescPrompt: 'Describe this clothing outfit in detail for a character in a roleplay. Focus on: type of garment, color, material/texture, style, notable features, accessories. Be concise but thorough (2-4 sentences). Write in English.',
});

const IMAGE_MODEL_KEYWORDS = [
    'dall-e', 'midjourney', 'mj', 'journey', 'stable-diffusion', 'sdxl', 'flux',
    'imagen', 'drawing', 'paint', 'image', 'seedream', 'hidream', 'dreamshaper',
    'ideogram', 'nano-banana', 'gpt-image', 'wanx', 'qwen'
];

const VIDEO_MODEL_KEYWORDS = [
    'sora', 'kling', 'jimeng', 'veo', 'pika', 'runway', 'luma',
    'video', 'gen-3', 'minimax', 'cogvideo', 'mochi', 'seedance',
    'vidu', 'wan-ai', 'hunyuan', 'hailuo'
];

function isImageModel(modelId) {
    const mid = modelId.toLowerCase();
    for (const kw of VIDEO_MODEL_KEYWORDS) { if (mid.includes(kw)) return false; }
    if (mid.includes('vision') && mid.includes('preview')) return false;
    for (const kw of IMAGE_MODEL_KEYWORDS) { if (mid.includes(kw)) return true; }
    return false;
}

function isGeminiModel(modelId) {
    return modelId.toLowerCase().includes('nano-banana');
}

function getSettings() {
    const context = SillyTavern.getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
            context.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    // v2.3: Migrate old wardrobe items without description
    const items = context.extensionSettings[MODULE_NAME].wardrobeItems || [];
    for (const item of items) {
        if (!Object.hasOwn(item, 'description')) {
            item.description = '';
        }
    }
    return context.extensionSettings[MODULE_NAME];
}

function saveSettings() {
    const context = SillyTavern.getContext();
    context.saveSettingsDebounced();
    iigLog('INFO', 'Settings saved.');
}

// ============================================================
// MODEL & AVATAR FETCHING
// ============================================================

async function fetchModels() {
    const settings = getSettings();
    if (!settings.endpoint || !settings.apiKey) return [];
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/models`;
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${settings.apiKey}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return (data.data || []).filter(m => isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        toastr.error(`Ошибка загрузки моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

// v2.3: Fetch text/vision models for description generation
async function fetchDescriptionModels() {
    const settings = getSettings();
    const endpoint = settings.wardrobeDescEndpoint || settings.endpoint;
    const apiKey = settings.wardrobeDescApiKey || settings.apiKey;
    if (!endpoint || !apiKey) return [];
    const url = `${endpoint.replace(/\/$/, '')}/v1/models`;
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        // Return non-image models (text/vision models)
        return (data.data || []).filter(m => !isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        toastr.error(`Ошибка загрузки текстовых моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

async function fetchUserAvatars() {
    try {
        const context = SillyTavern.getContext();
        const response = await fetch('/api/avatars/get', {
            method: 'POST',
            headers: context.getRequestHeaders(),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error('[IIG] Failed to fetch user avatars:', error);
        return [];
    }
}

async function imageUrlToBase64(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('[IIG] Failed to convert image to base64:', error);
        return null;
    }
}

async function saveImageToFile(dataUrl) {
    const context = SillyTavern.getContext();
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL format');
    const format = match[1];
    const base64Data = match[2];
    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'generated';
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `iig_${timestamp}`;
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ image: base64Data, format, ch_name: charName, filename })
    });
    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error || `Upload failed: ${response.status}`);
    }
    const result = await response.json();
    return result.path;
}

// ============================================================
// AVATAR RETRIEVAL
// ============================================================

async function getCharacterAvatarBase64() {
    try {
        const context = SillyTavern.getContext();
        if (context.characterId === undefined || context.characterId === null) return null;
        if (typeof context.getCharacterAvatar === 'function') {
            const avatarUrl = context.getCharacterAvatar(context.characterId);
            if (avatarUrl) return await imageUrlToBase64(avatarUrl);
        }
        const character = context.characters?.[context.characterId];
        if (character?.avatar) {
            return await imageUrlToBase64(`/characters/${encodeURIComponent(character.avatar)}`);
        }
        return null;
    } catch (error) {
        console.error('[IIG] Error getting character avatar:', error);
        return null;
    }
}

function getCharacterAvatarUrl() {
    try {
        const context = SillyTavern.getContext();
        if (context.characterId === undefined || context.characterId === null) return null;
        if (typeof context.getCharacterAvatar === 'function') {
            const url = context.getCharacterAvatar(context.characterId);
            if (url) return url;
        }
        const character = context.characters?.[context.characterId];
        if (character?.avatar) {
            return `/characters/${encodeURIComponent(character.avatar)}`;
        }
        return null;
    } catch (error) {
        return null;
    }
}

async function getUserAvatarBase64() {
    try {
        const settings = getSettings();
        if (!settings.userAvatarFile) return null;
        return await imageUrlToBase64(`/User Avatars/${encodeURIComponent(settings.userAvatarFile)}`);
    } catch (error) {
        console.error('[IIG] Error getting user avatar:', error);
        return null;
    }
}

function getUserAvatarUrl() {
    const settings = getSettings();
    if (!settings.userAvatarFile) return null;
    return `/User Avatars/${encodeURIComponent(settings.userAvatarFile)}`;
}

function getNpcAvatarBase64(npcId) {
    const settings = getSettings();
    const npc = settings.npcList.find(n => n.id === npcId);
    return npc?.avatarData || null;
}

// ============================================================
// RESIZE IMAGE
// ============================================================

async function resizeImageBase64(base64, maxSize = 512) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let { width, height } = img;
            if (width <= maxSize && height <= maxSize) { resolve(base64); return; }
            const ratio = Math.min(maxSize / width, maxSize / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/png').split(',')[1]);
        };
        img.onerror = () => resolve(base64);
        img.src = `data:image/png;base64,${base64}`;
    });
}

// ============================================================
// WARDROBE SYSTEM
// ============================================================

function generateWardrobeId() {
    return 'ward_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}

function addWardrobeItem(name, imageData, target = 'char') {
    const settings = getSettings();
    const item = {
        id: generateWardrobeId(),
        name: name || 'Outfit',
        imageData,
        description: '', // v2.3: text description of the outfit
        target, // 'char' or 'user'
        createdAt: Date.now(),
    };
    settings.wardrobeItems.push(item);
    saveSettings();
    return item;
}

function removeWardrobeItem(itemId) {
    const settings = getSettings();
    if (settings.activeWardrobeChar === itemId) settings.activeWardrobeChar = null;
    if (settings.activeWardrobeUser === itemId) settings.activeWardrobeUser = null;
    settings.wardrobeItems = settings.wardrobeItems.filter(w => w.id !== itemId);
    saveSettings();
    updateWardrobeInjection(); // v2.3: update injection when item removed
}

function setActiveWardrobe(itemId, target) {
    const settings = getSettings();
    if (target === 'char') {
        settings.activeWardrobeChar = settings.activeWardrobeChar === itemId ? null : itemId;
    } else {
        settings.activeWardrobeUser = settings.activeWardrobeUser === itemId ? null : itemId;
    }
    saveSettings();
    updateWardrobeInjection(); // v2.3: update injection when active outfit changes
}

function getActiveWardrobeItem(target) {
    const settings = getSettings();
    const activeId = target === 'char' ? settings.activeWardrobeChar : settings.activeWardrobeUser;
    if (!activeId) return null;
    return settings.wardrobeItems.find(w => w.id === activeId) || null;
}

// v2.3: Update wardrobe item description
function updateWardrobeItemDescription(itemId, description) {
    const settings = getSettings();
    const item = settings.wardrobeItems.find(w => w.id === itemId);
    if (item) {
        item.description = description;
        saveSettings();
        updateWardrobeInjection(); // update injection when description changes
        iigLog('INFO', `Updated description for wardrobe item "${item.name}" (${itemId})`);
    }
}

// ============================================================
// v2.3: WARDROBE DESCRIPTION GENERATION (Vision API)
// ============================================================

async function generateWardrobeDescription(itemId) {
    const settings = getSettings();
    const item = settings.wardrobeItems.find(w => w.id === itemId);
    if (!item?.imageData) throw new Error('Нет данных изображения для этого наряда');

    const endpoint = settings.wardrobeDescEndpoint || settings.endpoint;
    const apiKey = settings.wardrobeDescApiKey || settings.apiKey;
    const model = settings.wardrobeDescModel;

    if (!endpoint) throw new Error('Не настроен эндпоинт для генерации описаний');
    if (!apiKey) throw new Error('Не настроен API ключ для генерации описаний');
    if (!model) throw new Error('Не выбрана модель для генерации описаний');

    const url = `${endpoint.replace(/\/$/, '')}/v1/chat/completions`;

    const promptText = settings.wardrobeDescPrompt || defaultSettings.wardrobeDescPrompt;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: model,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'image_url',
                        image_url: {
                            url: `data:image/png;base64,${item.imageData}`
                        }
                    },
                    {
                        type: 'text',
                        text: promptText
                    }
                ]
            }],
            max_tokens: 500,
            temperature: 0.3,
        })
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`API ошибка (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    const description = result.choices?.[0]?.message?.content?.trim();

    if (!description) throw new Error('Модель вернула пустой ответ');

    iigLog('INFO', `Generated description for "${item.name}": ${description.substring(0, 100)}...`);
    return description;
}

// ============================================================
// v2.3: WARDROBE INJECTION INTO TEXT MODEL
// ============================================================

function updateWardrobeInjection() {
    try {
        const context = SillyTavern.getContext();
        const settings = getSettings();
        const injectionKey = MODULE_NAME + '_wardrobe';

        if (!settings.injectWardrobeToChat) {
            if (typeof context.setExtensionPrompt === 'function') {
                context.setExtensionPrompt(injectionKey, '', 0, 0);
            }
            return;
        }

        const parts = [];

        const charItem = getActiveWardrobeItem('char');
        if (charItem?.description) {
            const charName = context.characters?.[context.characterId]?.name || 'Character';
            parts.push(`[${charName} is currently wearing: ${charItem.description}]`);
        }

        const userItem = getActiveWardrobeItem('user');
        if (userItem?.description) {
            const userName = context.name1 || 'User';
            parts.push(`[${userName} is currently wearing: ${userItem.description}]`);
        }

        const injectionText = parts.join('\n');
        const depth = settings.wardrobeInjectionDepth || 1;

        if (typeof context.setExtensionPrompt === 'function') {
            // position: 1 = IN_PROMPT (after main prompt)
            context.setExtensionPrompt(injectionKey, injectionText, 1, depth);
            iigLog('INFO', `Wardrobe injection updated (${injectionText.length} chars, depth=${depth})`);
        } else {
            iigLog('WARN', 'setExtensionPrompt not available in this ST version');
        }
    } catch (error) {
        iigLog('ERROR', 'Error updating wardrobe injection:', error);
    }
}

// ============================================================
// NAME DETECTION IN PROMPT
// ============================================================

function detectMentionedCharacters(prompt) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const lowerPrompt = prompt.toLowerCase();
    const result = { charMentioned: false, userMentioned: false, npcIds: [] };

    const charName = context.characters?.[context.characterId]?.name;
    if (charName && lowerPrompt.includes(charName.toLowerCase())) result.charMentioned = true;

    const userName = context.name1;
    if (userName && lowerPrompt.includes(userName.toLowerCase())) result.userMentioned = true;

    for (const npc of (settings.npcList || [])) {
        if (!npc.name || npc.enabled === false) continue;
        const names = [npc.name, ...(npc.aliases || [])].filter(Boolean);
        for (const name of names) {
            if (lowerPrompt.includes(name.toLowerCase())) { result.npcIds.push(npc.id); break; }
        }
    }

    iigLog('INFO', `Name detection: char=${result.charMentioned}, user=${result.userMentioned}, npcs=[${result.npcIds.join(',')}]`);
    return result;
}

async function collectReferenceImages(prompt) {
    const settings = getSettings();
    const references = [];

    let mentions = { charMentioned: false, userMentioned: false, npcIds: [] };
    if (settings.autoDetectNames) mentions = detectMentionedCharacters(prompt);

    if (settings.sendCharAvatar || mentions.charMentioned) {
        const charAvatar = await getCharacterAvatarBase64();
        if (charAvatar) {
            const context = SillyTavern.getContext();
            const charName = context.characters?.[context.characterId]?.name || 'Character';
            references.push({ base64: charAvatar, label: `Reference image of ${charName}`, name: charName });
        }
    }

    if (settings.sendUserAvatar || mentions.userMentioned) {
        const userAvatar = await getUserAvatarBase64();
        if (userAvatar) {
            const context = SillyTavern.getContext();
            references.push({ base64: userAvatar, label: `Reference image of ${context.name1 || 'User'}`, name: context.name1 || 'User' });
        }
    }

    for (const npcId of mentions.npcIds) {
        const npc = settings.npcList.find(n => n.id === npcId);
        if (!npc?.avatarData || npc.enabled === false) continue;
        references.push({ base64: npc.avatarData, label: `Reference image of ${npc.name}`, name: npc.name });
    }

    // Wardrobe clothing references (v2.3: enriched with description)
    const charWardrobeItem = getActiveWardrobeItem('char');
    if (charWardrobeItem?.imageData) {
        const context = SillyTavern.getContext();
        const charName = context.characters?.[context.characterId]?.name || 'Character';
        let label = `Clothing reference for ${charName}: "${charWardrobeItem.name}". ${charName} MUST be wearing exactly this outfit.`;
        if (charWardrobeItem.description) {
            label += ` Outfit description: ${charWardrobeItem.description}`;
        }
        references.push({
            base64: charWardrobeItem.imageData,
            label,
            name: `${charName}'s outfit`,
        });
    }
    const userWardrobeItem = getActiveWardrobeItem('user');
    if (userWardrobeItem?.imageData) {
        const context = SillyTavern.getContext();
        const userName = context.name1 || 'User';
        let label = `Clothing reference for ${userName}: "${userWardrobeItem.name}". ${userName} MUST be wearing exactly this outfit.`;
        if (userWardrobeItem.description) {
            label += ` Outfit description: ${userWardrobeItem.description}`;
        }
        references.push({
            base64: userWardrobeItem.imageData,
            label,
            name: `${userName}'s outfit`,
        });
    }

    iigLog('INFO', `Total reference images: ${references.length}`);
    return references;
}

// ============================================================
// APPEARANCE EXTRACTION
// ============================================================

function extractCharacterAppearance() {
    try {
        const context = SillyTavern.getContext();
        if (context.characterId === undefined || context.characterId === null) return null;
        const character = context.characters?.[context.characterId];
        if (!character?.description) return null;

        const description = character.description;
        const charName = character.name || 'Character';

        const patterns = [
            /(?:hair|волосы)[:\s]*([^.;,\n]{3,80})/gi,
            /(?:has|have|with|имеет|с)\s+([a-zA-Zа-яА-Я\s]+(?:hair|волос[ыа]?))/gi,
            /([a-zA-Zа-яА-Я\-]+(?:\s+[a-zA-Zа-яА-Я\-]+)?)\s+hair/gi,
            /(?:eyes?|глаза?)[:\s]*([^.;,\n]{3,60})/gi,
            /([a-zA-Zа-яА-Я\-]+)\s+eyes?/gi,
            /(?:skin|кожа)[:\s]*([^.;,\n]{3,60})/gi,
            /([a-zA-Zа-яА-Я\-]+)\s+skin/gi,
            /(?:height|рост)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:tall|short|average|высок|низк|средн)[a-zA-Zа-яА-Я]*/gi,
            /(?:build|телосложени)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:muscular|slim|athletic|thin|chubby|мускулист|стройн|худ|полн)[a-zA-Zа-яА-Я]*/gi,
            /(?:looks?|appears?|выгляд)[a-zA-Zа-яА-Я]*\s+(?:like\s+)?(?:a\s+)?(\d+|young|old|teen|adult|молод|стар|подрост|взросл)/gi,
            /(\d+)\s*(?:years?\s*old|лет|года?)/gi,
            /(?:features?|черты)[:\s]*([^.;,\n]{3,80})/gi,
            /(?:face|лицо)[:\s]*([^.;,\n]{3,60})/gi,
            /(?:ears?|уши|ушки)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:tail|хвост)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:horns?|рога?)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:wings?|крыль[яи])[:\s]*([^.;,\n]{3,40})/gi,
        ];

        const foundTraits = [];
        const seen = new Set();
        for (const p of patterns) {
            for (const m of description.matchAll(p)) {
                const t = (m[1] || m[0]).trim();
                if (t.length > 2 && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); foundTraits.push(t); }
            }
        }

        const blockPatterns = [
            /\[?(?:appearance|внешность|looks?)\]?[:\s]*([^[\]]{10,500})/gi,
            /\[?(?:physical\s*description|физическое?\s*описание)\]?[:\s]*([^[\]]{10,500})/gi,
        ];
        for (const p of blockPatterns) {
            for (const m of description.matchAll(p)) {
                const b = m[1].trim();
                if (b.length > 10 && !seen.has(b.toLowerCase())) { seen.add(b.toLowerCase()); foundTraits.push(b); }
            }
        }

        if (foundTraits.length === 0) return null;
        return `${charName}'s appearance: ${foundTraits.join(', ')}`;
    } catch (error) {
        iigLog('ERROR', 'Error extracting character appearance:', error);
        return null;
    }
}

function extractUserAppearance() {
    try {
        const context = SillyTavern.getContext();
        const userName = context.name1 || 'User';
        let persona = null;
        if (typeof window.power_user !== 'undefined' && window.power_user.persona_description) {
            persona = window.power_user.persona_description;
        }
        if (!persona) return null;

        const patterns = [
            /(?:hair|волосы)[:\s]*([^.;,\n]{3,80})/gi,
            /(?:has|have|with|имеет|с)\s+([a-zA-Zа-яА-Я\s]+(?:hair|волос[ыа]?))/gi,
            /([a-zA-Zа-яА-Я\-]+(?:\s+[a-zA-Zа-яА-Я\-]+)?)\s+hair/gi,
            /(?:eyes?|глаза?)[:\s]*([^.;,\n]{3,60})/gi,
            /([a-zA-Zа-яА-Я\-]+)\s+eyes?/gi,
            /(?:skin|кожа)[:\s]*([^.;,\n]{3,60})/gi,
            /([a-zA-Zа-яА-Я\-]+)\s+skin/gi,
            /(?:height|рост)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:tall|short|average|высок|низк|средн)[a-zA-Zа-яА-Я]*/gi,
            /(?:build|телосложени)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:muscular|slim|athletic|thin|chubby|мускулист|стройн|худ|полн)[a-zA-Zа-яА-Я]*/gi,
            /(?:looks?|appears?|выгляд)[a-zA-Zа-яА-Я]*\s+(?:like\s+)?(?:a\s+)?(\d+|young|old|teen|adult|молод|стар|подрост|взросл)/gi,
            /(\d+)\s*(?:years?\s*old|лет|года?)/gi,
            /(?:features?|черты)[:\s]*([^.;,\n]{3,80})/gi,
            /(?:face|лицо)[:\s]*([^.;,\n]{3,60})/gi,
            /(?:ears?|уши|ушки)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:tail|хвост)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:horns?|рога?)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:wings?|крыль[яи])[:\s]*([^.;,\n]{3,40})/gi,
        ];

        const foundTraits = [];
        const seen = new Set();
        for (const p of patterns) {
            for (const m of persona.matchAll(p)) {
                const t = (m[1] || m[0]).trim();
                if (t.length > 2 && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); foundTraits.push(t); }
            }
        }

        const blockPatterns = [
            /\[?(?:appearance|внешность|looks?)\]?[:\s]*([^[\]]{10,500})/gi,
            /\[?(?:physical\s*description|физическое?\s*описание)\]?[:\s]*([^[\]]{10,500})/gi,
        ];
        for (const p of blockPatterns) {
            for (const m of persona.matchAll(p)) {
                const b = m[1].trim();
                if (b.length > 10 && !seen.has(b.toLowerCase())) { seen.add(b.toLowerCase()); foundTraits.push(b); }
            }
        }

        if (foundTraits.length === 0) {
            if (persona.length < 500) return `${userName}'s appearance: ${persona}`;
            return null;
        }
        return `${userName}'s appearance: ${foundTraits.join(', ')}`;
    } catch (error) {
        iigLog('ERROR', 'Error extracting user appearance:', error);
        return null;
    }
}

function getNpcAppearance(npcId) {
    const settings = getSettings();
    const npc = settings.npcList.find(n => n.id === npcId);
    if (!npc?.appearance || npc.enabled === false) return null;
    return `${npc.name}'s appearance: ${npc.appearance}`;
}

// ============================================================
// CLOTHING DETECTION
// ============================================================

function detectClothingFromChat(depth = 5) {
    try {
        const context = SillyTavern.getContext();
        const chat = context.chat;
        if (!chat || chat.length === 0) return null;

        const charName = context.characters?.[context.characterId]?.name || 'Character';
        const userName = context.name1 || 'User';

        const clothingPatterns = [
            /(?:wearing|wears?|dressed\s+in|clothed\s+in|puts?\s+on|changed?\s+into)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:outfit|clothes|clothing|attire|garment|dress|costume)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:shirt|blouse|top|jacket|coat|sweater|hoodie|t-shirt|tank\s*top)[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:pants|jeans|shorts|skirt|trousers|leggings)[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:dress|gown|robe|uniform|suit|armor|armour)[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:a|an|the|his|her|their|my)\s+([\w\s\-]+(?:dress|shirt|jacket|coat|pants|jeans|skirt|blouse|sweater|hoodie|uniform|suit|armor|robe|gown|outfit|costume|clothes))/gi,
            /(?:одет[аоы]?|носит|оделс?я?|переодел[аи]?сь?)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:одежда|наряд|костюм|форма)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:рубашк|блузк|куртк|пальто|свитер|худи|футболк|майк)[а-яА-Я]*[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:брюк|джинс|шорт|юбк|штан|леггинс)[а-яА-Я]*[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:платье|халат|мантия|униформа|доспех)[а-яА-Я]*[:\s]*([^.;!?\n]{3,100})/gi,
        ];

        const foundClothing = [];
        const seen = new Set();
        const startIndex = Math.max(0, chat.length - depth);

        for (let i = chat.length - 1; i >= startIndex; i--) {
            const message = chat[i];
            if (!message.mes) continue;
            const speaker = message.is_user ? userName : charName;
            for (const pattern of clothingPatterns) {
                pattern.lastIndex = 0;
                for (const match of message.mes.matchAll(pattern)) {
                    const clothing = (match[1] || match[0]).trim();
                    if (clothing.length > 3 && !seen.has(clothing.toLowerCase())) {
                        seen.add(clothing.toLowerCase());
                        foundClothing.push({ text: clothing, speaker });
                    }
                }
            }
        }

        if (foundClothing.length === 0) return null;

        const charClothing = foundClothing.filter(c => c.speaker === charName).map(c => c.text);
        const userClothing = foundClothing.filter(c => c.speaker === userName).map(c => c.text);

        let clothingText = '';
        if (charClothing.length > 0) clothingText += `${charName} is wearing: ${charClothing.slice(0, 3).join(', ')}. `;
        if (userClothing.length > 0) clothingText += `${userName} is wearing: ${userClothing.slice(0, 3).join(', ')}.`;
        return clothingText.trim() || null;
    } catch (error) {
        iigLog('ERROR', 'Error detecting clothing:', error);
        return null;
    }
}

// ============================================================
// ENHANCED PROMPT BUILDER
// ============================================================

function buildEnhancedPrompt(basePrompt, style, options = {}) {
    const context = SillyTavern.getContext();
    const settings = context.extensionSettings[MODULE_NAME] || {};
    const promptParts = [];

    if (settings.fixedStyleEnabled === true && settings.fixedStyle?.trim()) {
        promptParts.push(`[STYLE: ${settings.fixedStyle.trim()}]`);
    }

    if (settings.positivePrompt?.trim()) {
        promptParts.push(settings.positivePrompt.trim());
    }

    if (style && !(settings.fixedStyleEnabled === true && settings.fixedStyle?.trim())) {
        promptParts.push(`[Style: ${style}]`);
    }

    if (settings.extractAppearance === true) {
        const charAppearance = extractCharacterAppearance();
        if (charAppearance) promptParts.push(`[Character Reference: ${charAppearance}]`);
    }

    if (settings.extractUserAppearance !== false) {
        const userAppearance = extractUserAppearance();
        if (userAppearance) promptParts.push(`[User Reference: ${userAppearance}]`);
    }

    if (settings.autoDetectNames && settings.npcList?.length > 0) {
        const mentions = detectMentionedCharacters(basePrompt);
        for (const npcId of mentions.npcIds) {
            const npcAppearance = getNpcAppearance(npcId);
            if (npcAppearance) promptParts.push(`[NPC Reference: ${npcAppearance}]`);
        }
    }

    if (settings.detectClothing === true) {
        const clothing = detectClothingFromChat(settings.clothingSearchDepth || 5);
        if (clothing) promptParts.push(`[Current Clothing: ${clothing}]`);
    }

    // Wardrobe clothing instructions (v2.3: now includes text description)
    const charWardrobeItem = getActiveWardrobeItem('char');
    if (charWardrobeItem) {
        const charName = context.characters?.[context.characterId]?.name || 'Character';
        let wardrobeInstruction = `[CLOTHING OVERRIDE for ${charName}: The character MUST be wearing the outfit shown in the clothing reference image "${charWardrobeItem.name}". Ignore any other clothing descriptions — use ONLY the referenced outfit.`;
        if (charWardrobeItem.description) {
            wardrobeInstruction += ` Detailed outfit description: ${charWardrobeItem.description}`;
        }
        wardrobeInstruction += ']';
        promptParts.push(wardrobeInstruction);
    }
    const userWardrobeItem = getActiveWardrobeItem('user');
    if (userWardrobeItem) {
        const userName = context.name1 || 'User';
        let wardrobeInstruction = `[CLOTHING OVERRIDE for ${userName}: This person MUST be wearing the outfit shown in the clothing reference image "${userWardrobeItem.name}". Ignore any other clothing descriptions — use ONLY the referenced outfit.`;
        if (userWardrobeItem.description) {
            wardrobeInstruction += ` Detailed outfit description: ${userWardrobeItem.description}`;
        }
        wardrobeInstruction += ']';
        promptParts.push(wardrobeInstruction);
    }

    if (options._referenceLabels?.length > 0) {
        const labelsText = options._referenceLabels.map((ref, i) =>
            `Reference image ${i + 1}: ${ref.label} (${ref.name})`
        ).join('; ');
        promptParts.push(`[CRITICAL: The reference images provided above show EXACT appearances. ${labelsText}. You MUST precisely copy their face structure, eye color, hair color and style, skin tone, body type, and all distinctive features from these references.]`);
    }

    promptParts.push(basePrompt);

    if (settings.negativePrompt?.trim()) {
        promptParts.push(`[AVOID: ${settings.negativePrompt.trim()}]`);
    }

    const fullPrompt = promptParts.join('\n\n');
    iigLog('INFO', `Built enhanced prompt (${fullPrompt.length} chars, ${promptParts.length} parts)`);
    return fullPrompt;
}

// ============================================================
// IMAGE GENERATION APIs
// ============================================================

async function generateImageOpenAI(prompt, style, references = [], options = {}) {
    const settings = getSettings();
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/images/generations`;
    const fullPrompt = buildEnhancedPrompt(prompt, style, options);

    let size = settings.size;
    if (options.aspectRatio) {
        if (options.aspectRatio === '16:9') size = '1792x1024';
        else if (options.aspectRatio === '9:16') size = '1024x1792';
        else if (options.aspectRatio === '1:1') size = '1024x1024';
    }

    const body = {
        model: settings.model,
        prompt: fullPrompt,
        n: 1,
        size,
        quality: options.quality || settings.quality,
        response_format: 'b64_json'
    };

    if (references.length > 0) {
        body.image = `data:image/png;base64,${references[0].base64}`;
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) throw new Error(`API Error (${response.status}): ${await response.text()}`);

    const result = await response.json();
    const dataList = result.data || [];
    if (dataList.length === 0) {
        if (result.url) return result.url;
        throw new Error('No image data in response');
    }
    const imageObj = dataList[0];
    if (imageObj.b64_json) return `data:image/png;base64,${imageObj.b64_json}`;
    return imageObj.url;
}

const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];

async function generateImageGemini(prompt, style, references = [], options = {}) {
    const settings = getSettings();
    const model = settings.model;
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;

    let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) aspectRatio = '1:1';
    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) imageSize = '1K';

    const parts = [];
    for (const ref of references.slice(0, 4)) {
        parts.push({ inlineData: { mimeType: 'image/png', data: ref.base64 } });
        parts.push({ text: `[Above image: ${ref.label}]` });
    }

    const fullPrompt = buildEnhancedPrompt(prompt, style, { ...options, _referenceLabels: references });
    parts.push({ text: fullPrompt });

    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio, imageSize } }
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) throw new Error(`API Error (${response.status}): ${await response.text()}`);

    const result = await response.json();
    const candidates = result.candidates || [];
    if (candidates.length === 0) throw new Error('No candidates in response');

    for (const part of (candidates[0].content?.parts || [])) {
        if (part.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        if (part.inline_data) return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
    }
    throw new Error('No image found in Gemini response');
}

// ============================================================
// GENERATION WITH RETRY
// ============================================================

function validateSettings() {
    const settings = getSettings();
    const errors = [];
    if (!settings.endpoint) errors.push('URL эндпоинта не настроен');
    if (!settings.apiKey) errors.push('API ключ не настроен');
    if (!settings.model) errors.push('Модель не выбрана');
    if (errors.length > 0) throw new Error(`Ошибка настроек: ${errors.join(', ')}`);
}

async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    validateSettings();
    const settings = getSettings();

    onStatusUpdate?.('Сбор референсов...');
    const references = await collectReferenceImages(prompt);

    let lastError;
    for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
        try {
            onStatusUpdate?.(`Генерация${attempt > 0 ? ` (повтор ${attempt}/${settings.maxRetries})` : ''}...`);
            if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
                return await generateImageGemini(prompt, style, references, options);
            } else {
                return await generateImageOpenAI(prompt, style, references, options);
            }
        } catch (error) {
            lastError = error;
            const isRetryable = /429|503|502|504|timeout|network/i.test(error.message);
            if (!isRetryable || attempt === settings.maxRetries) break;
            const delay = settings.retryDelay * Math.pow(2, attempt);
            onStatusUpdate?.(`Повтор через ${delay / 1000}с...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

// ============================================================
// TAG PARSING
// ============================================================
async function checkFileExists(path) {
    try { return (await fetch(path, { method: 'HEAD' })).ok; } catch (e) { return false; }
}

const ERROR_IMAGE_PATH = '/scripts/extensions/third-party/sillyimages/error.svg';

async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];

    // NEW FORMAT
    const imgTagMarker = 'data-iig-instruction=';
    let searchPos = 0;
    while (true) {
        const markerPos = text.indexOf(imgTagMarker, searchPos);
        if (markerPos === -1) break;
        let imgStart = text.lastIndexOf('<img', markerPos);
        if (imgStart === -1 || markerPos - imgStart > 500) { searchPos = markerPos + 1; continue; }
        const afterMarker = markerPos + imgTagMarker.length;
        let jsonStart = text.indexOf('{', afterMarker);
        if (jsonStart === -1 || jsonStart > afterMarker + 10) { searchPos = markerPos + 1; continue; }

        let braceCount = 0, jsonEnd = -1, inString = false, escapeNext = false;
        for (let i = jsonStart; i < text.length; i++) {
            const c = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (c === '\\' && inString) { escapeNext = true; continue; }
            if (c === '"') { inString = !inString; continue; }
            if (!inString) {
                if (c === '{') braceCount++;
                else if (c === '}') { braceCount--; if (braceCount === 0) { jsonEnd = i + 1; break; } }
            }
        }
        if (jsonEnd === -1) { searchPos = markerPos + 1; continue; }
        let imgEnd = text.indexOf('>', jsonEnd);
        if (imgEnd === -1) { searchPos = markerPos + 1; continue; }
        imgEnd++;

        const fullImgTag = text.substring(imgStart, imgEnd);
        const instructionJson = text.substring(jsonStart, jsonEnd);
        const srcMatch = fullImgTag.match(/src\s*=\s*["']?([^"'\s>]+)/i);
        const srcValue = srcMatch ? srcMatch[1] : '';

        let needsGeneration = false;
        const hasMarker = srcValue.includes('[IMG:GEN]') || srcValue.includes('[IMG:');
        const hasErrorImage = srcValue.includes('error.svg');
        const hasPath = srcValue && srcValue.startsWith('/') && srcValue.length > 5;

        if (hasErrorImage && !forceAll) { searchPos = imgEnd; continue; }
        if (forceAll) needsGeneration = true;
        else if (hasMarker || !srcValue) needsGeneration = true;
        else if (hasPath && checkExistence) { if (!(await checkFileExists(srcValue))) needsGeneration = true; }
        else if (hasPath) { searchPos = imgEnd; continue; }

        if (!needsGeneration) { searchPos = imgEnd; continue; }

        try {
            let nj = instructionJson.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
            const data = JSON.parse(nj);
            tags.push({
                fullMatch: fullImgTag, index: imgStart,
                style: data.style || '', prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: true, existingSrc: hasPath ? srcValue : null
            });
        } catch (e) { iigLog('WARN', `Failed to parse instruction JSON`, e.message); }
        searchPos = imgEnd;
    }

    // LEGACY FORMAT
    const marker = '[IMG:GEN:';
    let searchStart = 0;
    while (true) {
        const markerIndex = text.indexOf(marker, searchStart);
        if (markerIndex === -1) break;
        const jsonStart = markerIndex + marker.length;
        let braceCount = 0, jsonEnd = -1, inString = false, escapeNext = false;
        for (let i = jsonStart; i < text.length; i++) {
            const c = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (c === '\\' && inString) { escapeNext = true; continue; }
            if (c === '"') { inString = !inString; continue; }
            if (!inString) {
                if (c === '{') braceCount++;
                else if (c === '}') { braceCount--; if (braceCount === 0) { jsonEnd = i + 1; break; } }
            }
        }
        if (jsonEnd === -1) { searchStart = jsonStart; continue; }
        if (!text.substring(jsonEnd).startsWith(']')) { searchStart = jsonEnd; continue; }
        const tagOnly = text.substring(markerIndex, jsonEnd + 1);
        const jsonStr = text.substring(jsonStart, jsonEnd);
        try {
            const data = JSON.parse(jsonStr.replace(/'/g, '"'));
            tags.push({
                fullMatch: tagOnly, index: markerIndex,
                style: data.style || '', prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: false
            });
        } catch (e) { iigLog('WARN', `Failed to parse legacy tag`, e.message); }
        searchStart = jsonEnd + 1;
    }
    return tags;
}

// ============================================================
// DOM HELPERS
// ============================================================

function createLoadingPlaceholder(tagId) {
    const el = document.createElement('div');
    el.className = 'iig-loading-placeholder';
    el.dataset.tagId = tagId;
    el.innerHTML = `<div class="iig-spinner"></div><div class="iig-status">Генерация картинки...</div>`;
    return el;
}

function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = ERROR_IMAGE_PATH;
    img.alt = 'Ошибка генерации';
    img.title = `Ошибка: ${errorMessage}`;
    img.dataset.tagId = tagId;
    if (tagInfo.fullMatch) {
        const m = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (m) img.setAttribute('data-iig-instruction', m[2]);
    }
    return img;
}

// ============================================================
// MESSAGE PROCESSING
// ============================================================

async function processMessageTags(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.enabled) return;
    if (processingMessages.has(messageId)) return;

    const message = context.chat[messageId];
    if (!message || message.is_user) return;

    const tags = await parseImageTags(message.mes, { checkExistence: true });
    if (tags.length === 0) return;

    processingMessages.add(messageId);
    toastr.info(`Найдено тегов: ${tags.length}. Генерация...`, 'Генерация картинок', { timeOut: 3000 });

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) { processingMessages.delete(messageId); return; }
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) { processingMessages.delete(messageId); return; }

    const processTag = async (tag, index) => {
        const tagId = `iig-${messageId}-${index}`;
        const loadingPlaceholder = createLoadingPlaceholder(tagId);
        let targetElement = null;

        if (tag.isNewFormat) {
            const allImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
            const searchPrompt = tag.prompt.substring(0, 30);
            for (const img of allImgs) {
                const instr = img.getAttribute('data-iig-instruction');
                if (instr) {
                    const decoded = instr.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
                    if (decoded.includes(searchPrompt)) { targetElement = img; break; }
                    try { const d = JSON.parse(decoded.replace(/'/g, '"')); if (d.prompt?.substring(0, 30) === tag.prompt.substring(0, 30)) { targetElement = img; break; } } catch (e) {}
                    if (instr.includes(searchPrompt)) { targetElement = img; break; }
                }
            }
            if (!targetElement) {
                for (const img of allImgs) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]') || src === '' || src === '#') { targetElement = img; break; }
                }
            }
            if (!targetElement) {
                for (const img of mesTextEl.querySelectorAll('img')) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) { targetElement = img; break; }
                }
            }
        } else {
            const esc = tag.fullMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '(?:"|&quot;)');
            const before = mesTextEl.innerHTML;
            mesTextEl.innerHTML = mesTextEl.innerHTML.replace(new RegExp(esc, 'g'), `<span data-iig-placeholder="${tagId}"></span>`);
            if (before !== mesTextEl.innerHTML) targetElement = mesTextEl.querySelector(`[data-iig-placeholder="${tagId}"]`);
            if (!targetElement) {
                for (const img of mesTextEl.querySelectorAll('img')) {
                    if (img.src?.includes('[IMG:GEN:')) { targetElement = img; break; }
                }
            }
        }

        if (targetElement) targetElement.replaceWith(loadingPlaceholder);
        else mesTextEl.appendChild(loadingPlaceholder);

        const statusEl = loadingPlaceholder.querySelector('.iig-status');
        try {
            const dataUrl = await generateImageWithRetry(tag.prompt, tag.style, (s) => { statusEl.textContent = s; }, { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality });
            statusEl.textContent = 'Сохранение...';
            const imagePath = await saveImageToFile(dataUrl);
            const img = document.createElement('img');
            img.className = 'iig-generated-image'; img.src = imagePath; img.alt = tag.prompt;
            if (tag.isNewFormat) { const m = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i); if (m) img.setAttribute('data-iig-instruction', m[2]); }
            loadingPlaceholder.replaceWith(img);
            if (tag.isNewFormat) { message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`)); }
            else { message.mes = message.mes.replace(tag.fullMatch, `[IMG:✓:${imagePath}]`); }
            toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Failed: ${error.message}`);
            loadingPlaceholder.replaceWith(createErrorPlaceholder(tagId, error.message, tag));
            if (tag.isNewFormat) { message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${ERROR_IMAGE_PATH}"`)); }
            else { message.mes = message.mes.replace(tag.fullMatch, `[IMG:ERROR:${error.message.substring(0, 50)}]`); }
            toastr.error(`Ошибка генерации: ${error.message}`, 'Генерация картинок');
        }
    };

    try { await Promise.all(tags.map((tag, i) => processTag(tag, i))); }
    finally { processingMessages.delete(messageId); }
    await context.saveChat();
    if (typeof context.messageFormatting === 'function') {
        mesTextEl.innerHTML = context.messageFormatting(message.mes, message.name, message.is_system, message.is_user, messageId);
    }
}

async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message) { toastr.error('Сообщение не найдено'); return; }
    const tags = await parseImageTags(message.mes, { forceAll: true });
    if (tags.length === 0) { toastr.warning('Нет тегов для перегенерации'); return; }

    processingMessages.add(messageId);
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) { processingMessages.delete(messageId); return; }
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) { processingMessages.delete(messageId); return; }

    for (let index = 0; index < tags.length; index++) {
        const tag = tags[index];
        try {
            const existingImg = mesTextEl.querySelector('img[data-iig-instruction]');
            if (existingImg) {
                const instruction = existingImg.getAttribute('data-iig-instruction');
                const lp = createLoadingPlaceholder(`iig-regen-${messageId}-${index}`);
                existingImg.replaceWith(lp);
                const statusEl = lp.querySelector('.iig-status');
                const dataUrl = await generateImageWithRetry(tag.prompt, tag.style, (s) => { statusEl.textContent = s; }, { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality });
                statusEl.textContent = 'Сохранение...';
                const imagePath = await saveImageToFile(dataUrl);
                const img = document.createElement('img');
                img.className = 'iig-generated-image'; img.src = imagePath; img.alt = tag.prompt;
                if (instruction) img.setAttribute('data-iig-instruction', instruction);
                lp.replaceWith(img);
                message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`));
                toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
            }
        } catch (error) { toastr.error(`Ошибка: ${error.message}`); }
    }
    processingMessages.delete(messageId);
    await context.saveChat();
}

function addRegenerateButton(messageElement, messageId) {
    if (messageElement.querySelector('.iig-regenerate-btn')) return;
    const extra = messageElement.querySelector('.extraMesButtons');
    if (!extra) return;
    const btn = document.createElement('div');
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = 'Перегенерировать картинки';
    btn.tabIndex = 0;
    btn.addEventListener('click', async (e) => { e.stopPropagation(); await regenerateMessageImages(messageId); });
    extra.appendChild(btn);
}

function addButtonsToExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat?.length) return;
    for (const el of document.querySelectorAll('#chat .mes')) {
        const mesId = el.getAttribute('mesid');
        if (mesId === null) continue;
        const mid = parseInt(mesId, 10);
        const msg = context.chat[mid];
        if (msg && !msg.is_user) addRegenerateButton(el, mid);
    }
}

async function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    const el = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!el) return;
    addRegenerateButton(el, messageId);
    await processMessageTags(messageId);
}

// ============================================================
// NPC MANAGEMENT
// ============================================================

function generateNpcId() {
    return 'npc_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}

function addNpc() {
    const settings = getSettings();
    const npc = { id: generateNpcId(), name: '', aliases: [], avatarData: null, appearance: '', enabled: true };
    settings.npcList.push(npc);
    saveSettings();
    return npc;
}

function removeNpc(npcId) {
    const settings = getSettings();
    settings.npcList = settings.npcList.filter(n => n.id !== npcId);
    saveSettings();
}

function updateNpc(npcId, updates) {
    const settings = getSettings();
    const npc = settings.npcList.find(n => n.id === npcId);
    if (npc) { Object.assign(npc, updates); saveSettings(); }
}

function toggleNpc(npcId) {
    const settings = getSettings();
    const npc = settings.npcList.find(n => n.id === npcId);
    if (npc) {
        npc.enabled = npc.enabled === false ? true : false;
        saveSettings();
    }
    return npc;
}

// ============================================================
// COLLAPSIBLE SECTION HELPER
// ============================================================

function isSectionCollapsed(sectionId) {
    const settings = getSettings();
    return settings.collapsedSections?.[sectionId] === true;
}

function toggleSectionCollapsed(sectionId) {
    const settings = getSettings();
    if (!settings.collapsedSections) settings.collapsedSections = {};
    settings.collapsedSections[sectionId] = !settings.collapsedSections[sectionId];
    saveSettings();
}

function createCollapsibleSection(id, icon, title, contentHtml) {
    const collapsed = isSectionCollapsed(id);
    return `
        <div class="iig-section" data-section-id="${id}">
            <div class="iig-section-header" data-section-toggle="${id}">
                <span class="iig-section-icon">${icon}</span>
                <span class="iig-section-title">${title}</span>
                <i class="fa-solid fa-chevron-down iig-section-chevron ${collapsed ? 'iig-collapsed' : ''}"></i>
            </div>
            <div class="iig-section-body ${collapsed ? 'iig-section-hidden' : ''}">
                ${contentHtml}
            </div>
        </div>
    `;
}

// ============================================================
// AVATAR PREVIEW UPDATES
// ============================================================

function updateCharAvatarPreview() {
    const previewEl = document.getElementById('iig_char_avatar_preview');
    if (!previewEl) return;
    const avatarUrl = getCharacterAvatarUrl();
    if (avatarUrl) {
        previewEl.innerHTML = `<img src="${avatarUrl}" class="iig-avatar-preview-img" alt="Аватар персонажа">`;
    } else {
        previewEl.innerHTML = `<div class="iig-avatar-preview-empty"><i class="fa-solid fa-user"></i><span>Нет аватара</span></div>`;
    }
}

function updateUserAvatarPreview() {
    const previewEl = document.getElementById('iig_user_avatar_preview');
    if (!previewEl) return;
    const avatarUrl = getUserAvatarUrl();
    if (avatarUrl) {
        previewEl.innerHTML = `<img src="${avatarUrl}" class="iig-avatar-preview-img" alt="Аватар юзера">`;
    } else {
        previewEl.innerHTML = `<div class="iig-avatar-preview-empty"><i class="fa-solid fa-user"></i><span>Не выбран</span></div>`;
    }
}

// ============================================================
// WARDROBE UI
// ============================================================

function renderWardrobeGrid(target) {
    const settings = getSettings();
    const containerId = target === 'char' ? 'iig_wardrobe_char' : 'iig_wardrobe_user';
    const container = document.getElementById(containerId);
    if (!container) return;

    const items = settings.wardrobeItems.filter(w => w.target === target);
    const activeId = target === 'char' ? settings.activeWardrobeChar : settings.activeWardrobeUser;

    if (items.length === 0) {
        container.innerHTML = `<div class="iig-wardrobe-empty">Нет одежды. Нажмите + чтобы добавить.</div>`;
        renderWardrobeDescriptionPanel(target); // v2.3
        return;
    }

    container.innerHTML = items.map(item => `
        <div class="iig-wardrobe-card ${item.id === activeId ? 'iig-wardrobe-active' : ''}" data-ward-id="${item.id}" data-ward-target="${target}">
            <img src="data:image/png;base64,${item.imageData}" class="iig-wardrobe-img" alt="${item.name}">
            <div class="iig-wardrobe-card-overlay">
                <span class="iig-wardrobe-card-name" title="${item.name}">${item.name}</span>
                <div class="iig-wardrobe-card-actions">
                    ${item.description ? '<i class="fa-solid fa-file-lines iig-wardrobe-has-desc" title="Есть описание"></i>' : ''}
                    <i class="fa-solid fa-trash iig-wardrobe-delete" data-ward-del="${item.id}" title="Удалить"></i>
                </div>
            </div>
            ${item.id === activeId ? '<div class="iig-wardrobe-check"><i class="fa-solid fa-check"></i></div>' : ''}
        </div>
    `).join('');

    // Bind events
    container.querySelectorAll('.iig-wardrobe-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('.iig-wardrobe-delete')) return;
            const wardId = card.dataset.wardId;
            const wardTarget = card.dataset.wardTarget;
            setActiveWardrobe(wardId, wardTarget);
            renderWardrobeGrid(wardTarget);
        });
    });

    container.querySelectorAll('.iig-wardrobe-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const wardId = btn.dataset.wardDel;
            removeWardrobeItem(wardId);
            renderWardrobeGrid(target);
            toastr.info('Одежда удалена');
        });
    });

    // v2.3: Render description panel for active item
    renderWardrobeDescriptionPanel(target);
}

// v2.3: Description panel for active wardrobe item
function renderWardrobeDescriptionPanel(target) {
    const panelId = `iig_wardrobe_desc_${target}`;
    let panel = document.getElementById(panelId);

    // Create panel container if it doesn't exist
    if (!panel) {
        const gridContainer = document.getElementById(target === 'char' ? 'iig_wardrobe_char' : 'iig_wardrobe_user');
        if (!gridContainer) return;
        panel = document.createElement('div');
        panel.id = panelId;
        panel.className = 'iig-wardrobe-desc-panel';
        // Insert after the grid container
        gridContainer.parentNode.insertBefore(panel, gridContainer.nextSibling);
    }

    const activeItem = getActiveWardrobeItem(target);

    if (!activeItem) {
        panel.innerHTML = '';
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';
    panel.innerHTML = `
        <div class="iig-wardrobe-desc-header">
            <i class="fa-solid fa-shirt"></i>
            <span>Описание: <b>${activeItem.name}</b></span>
        </div>
        <textarea class="text_pole iig-wardrobe-desc-textarea" rows="3"
            placeholder="Введите описание одежды вручную или сгенерируйте через AI..."
            data-ward-id="${activeItem.id}">${activeItem.description || ''}</textarea>
        <div class="iig-wardrobe-desc-actions">
            <div class="menu_button iig-wardrobe-desc-generate" data-ward-id="${activeItem.id}" title="Сгенерировать описание через Vision AI">
                <i class="fa-solid fa-robot"></i> Сгенерировать
            </div>
            <div class="menu_button iig-wardrobe-desc-save" data-ward-id="${activeItem.id}" title="Сохранить описание">
                <i class="fa-solid fa-floppy-disk"></i> Сохранить
            </div>
            <div class="menu_button iig-wardrobe-desc-clear" data-ward-id="${activeItem.id}" title="Очистить описание">
                <i class="fa-solid fa-eraser"></i>
            </div>
        </div>
        <div class="iig-wardrobe-desc-status" id="iig_wardrobe_desc_status_${target}" style="display:none;"></div>
    `;

    // Bind save on textarea blur
    const textarea = panel.querySelector('.iig-wardrobe-desc-textarea');
    textarea?.addEventListener('blur', () => {
        const wardId = textarea.dataset.wardId;
        updateWardrobeItemDescription(wardId, textarea.value);
    });

    // Save button
    panel.querySelector('.iig-wardrobe-desc-save')?.addEventListener('click', () => {
        const wardId = textarea.dataset.wardId;
        updateWardrobeItemDescription(wardId, textarea.value);
        toastr.success('Описание сохранено');
        renderWardrobeGrid(target); // refresh card indicator
    });

    // Clear button
    panel.querySelector('.iig-wardrobe-desc-clear')?.addEventListener('click', () => {
        textarea.value = '';
        const wardId = textarea.dataset.wardId;
        updateWardrobeItemDescription(wardId, '');
        toastr.info('Описание очищено');
        renderWardrobeGrid(target);
    });

    // Generate button
    panel.querySelector('.iig-wardrobe-desc-generate')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const wardId = btn.dataset.wardId;
        const statusEl = document.getElementById(`iig_wardrobe_desc_status_${target}`);

        btn.classList.add('disabled');
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Генерация...';
        if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Отправка картинки vision-модели...'; }

        try {
            const description = await generateWardrobeDescription(wardId);
            textarea.value = description;
            updateWardrobeItemDescription(wardId, description);
            if (statusEl) { statusEl.textContent = 'Описание сгенерировано!'; statusEl.className = 'iig-wardrobe-desc-status iig-desc-success'; }
            toastr.success('Описание сгенерировано через AI');
            renderWardrobeGrid(target);
        } catch (error) {
            iigLog('ERROR', 'Failed to generate wardrobe description:', error);
            if (statusEl) { statusEl.textContent = `Ошибка: ${error.message}`; statusEl.className = 'iig-wardrobe-desc-status iig-desc-error'; }
            toastr.error(`Ошибка генерации описания: ${error.message}`);
        } finally {
            btn.classList.remove('disabled');
            btn.innerHTML = '<i class="fa-solid fa-robot"></i> Сгенерировать';
            setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 5000);
        }
    });
}

// ============================================================
// SETTINGS UI
// ============================================================

function renderNpcList() {
    const settings = getSettings();
    const container = document.getElementById('iig_npc_list');
    if (!container) return;
    container.innerHTML = '';

    for (const npc of settings.npcList) {
        const isEnabled = npc.enabled !== false;
        const npcEl = document.createElement('div');
        npcEl.className = `iig-npc-item ${!isEnabled ? 'iig-npc-disabled' : ''}`;
        npcEl.dataset.npcId = npc.id;

        const avatarPreview = npc.avatarData
            ? `<img src="data:image/png;base64,${npc.avatarData}" class="iig-npc-avatar-preview" alt="NPC avatar">`
            : `<div class="iig-npc-avatar-preview iig-npc-no-avatar"><i class="fa-solid fa-user-plus"></i></div>`;

        npcEl.innerHTML = `
            <div class="iig-npc-header">
                <div class="iig-npc-avatar-container">
                    ${avatarPreview}
                    <input type="file" class="iig-npc-avatar-input" accept="image/*" style="display:none;">
                    <div class="iig-npc-avatar-upload-btn menu_button" title="Загрузить аватар"><i class="fa-solid fa-upload"></i></div>
                </div>
                <div class="iig-npc-fields">
                    <input type="text" class="text_pole iig-npc-name" placeholder="Имя NPC" value="${npc.name || ''}">
                    <input type="text" class="text_pole iig-npc-aliases" placeholder="Алиасы (через запятую)" value="${(npc.aliases || []).join(', ')}">
                </div>
                <div class="iig-npc-btn-group">
                    <div class="iig-npc-toggle menu_button ${isEnabled ? 'iig-npc-on' : 'iig-npc-off'}" title="${isEnabled ? 'Выключить NPC' : 'Включить NPC'}">
                        <i class="fa-solid ${isEnabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                    </div>
                    <div class="iig-npc-remove menu_button" title="Удалить NPC"><i class="fa-solid fa-trash"></i></div>
                </div>
            </div>
            <textarea class="text_pole iig-npc-appearance" rows="2" placeholder="Описание внешности (опционально)">${npc.appearance || ''}</textarea>
        `;

        npcEl.querySelector('.iig-npc-name').addEventListener('input', (e) => updateNpc(npc.id, { name: e.target.value }));
        npcEl.querySelector('.iig-npc-aliases').addEventListener('input', (e) => {
            updateNpc(npc.id, { aliases: e.target.value.split(',').map(a => a.trim()).filter(Boolean) });
        });
        npcEl.querySelector('.iig-npc-appearance').addEventListener('input', (e) => updateNpc(npc.id, { appearance: e.target.value }));

        npcEl.querySelector('.iig-npc-toggle').addEventListener('click', () => {
            toggleNpc(npc.id);
            renderNpcList();
        });

        const uploadBtn = npcEl.querySelector('.iig-npc-avatar-upload-btn');
        const fileInput = npcEl.querySelector('.iig-npc-avatar-input');
        uploadBtn.addEventListener('click', () => fileInput.click());
        npcEl.querySelector('.iig-npc-avatar-container').addEventListener('click', (e) => {
            if (!e.target.closest('.iig-npc-avatar-upload-btn')) fileInput.click();
        });
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onloadend = async () => {
                const resized = await resizeImageBase64(reader.result.split(',')[1], 512);
                updateNpc(npc.id, { avatarData: resized });
                renderNpcList();
                toastr.success(`Аватар загружен для ${npc.name || 'NPC'}`, 'Генерация картинок');
            };
            reader.readAsDataURL(file);
        });

        npcEl.querySelector('.iig-npc-remove').addEventListener('click', () => {
            removeNpc(npc.id);
            renderNpcList();
            toastr.info('NPC удалён');
        });

        container.appendChild(npcEl);
    }
}

function createSettingsUI() {
    const settings = getSettings();
    const container = document.getElementById('extensions_settings');
    if (!container) return;

    // Build section contents
    const apiSectionContent = `
        <div class="flex-row">
            <label for="iig_api_type">Тип API</label>
            <select id="iig_api_type" class="flex1">
                <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-совместимый</option>
                <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini-совместимый (nano-banana)</option>
            </select>
        </div>
        <div class="flex-row">
            <label for="iig_endpoint">URL эндпоинта</label>
            <input type="text" id="iig_endpoint" class="text_pole flex1" value="${settings.endpoint}" placeholder="https://api.example.com">
        </div>
        <div class="flex-row">
            <label for="iig_api_key">API ключ</label>
            <input type="password" id="iig_api_key" class="text_pole flex1" value="${settings.apiKey}">
            <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть"><i class="fa-solid fa-eye"></i></div>
        </div>
        <div class="flex-row">
            <label for="iig_model">Модель</label>
            <select id="iig_model" class="flex1">
                ${settings.model ? `<option value="${settings.model}" selected>${settings.model}</option>` : '<option value="">-- Выберите --</option>'}
            </select>
            <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Обновить"><i class="fa-solid fa-sync"></i></div>
        </div>
    `;

    const genParamsSectionContent = `
        <div class="flex-row">
            <label for="iig_size">Размер (OpenAI)</label>
            <select id="iig_size" class="flex1">
                <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>1024x1024</option>
                <option value="1792x1024" ${settings.size === '1792x1024' ? 'selected' : ''}>1792x1024</option>
                <option value="1024x1792" ${settings.size === '1024x1792' ? 'selected' : ''}>1024x1792</option>
                <option value="512x512" ${settings.size === '512x512' ? 'selected' : ''}>512x512</option>
            </select>
        </div>
        <div class="flex-row">
            <label for="iig_quality">Качество</label>
            <select id="iig_quality" class="flex1">
                <option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>Стандартное</option>
                <option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>HD</option>
            </select>
        </div>
        <div class="flex-row">
            <label for="iig_aspect_ratio">Соотношение сторон</label>
            <select id="iig_aspect_ratio" class="flex1">
                ${VALID_ASPECT_RATIOS.map(r => `<option value="${r}" ${settings.aspectRatio === r ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
        </div>
        <div class="flex-row">
            <label for="iig_image_size">Разрешение</label>
            <select id="iig_image_size" class="flex1">
                ${VALID_IMAGE_SIZES.map(s => `<option value="${s}" ${settings.imageSize === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
        </div>
    `;

    const referencesSectionContent = `
        <label class="checkbox_label">
            <input type="checkbox" id="iig_auto_detect_names" ${settings.autoDetectNames ? 'checked' : ''}>
            <span>Автоопределение имён в промпте</span>
        </label>
        <p class="hint">Если имя персонажа/юзера/NPC упомянуто — аватарка автоматически добавится как референс.</p>

        <label class="checkbox_label">
            <input type="checkbox" id="iig_send_char_avatar" ${settings.sendCharAvatar ? 'checked' : ''}>
            <span>Всегда отправлять аватар персонажа</span>
        </label>
        <div id="iig_char_avatar_preview" class="iig-avatar-preview-container">
            <div class="iig-avatar-preview-empty"><i class="fa-solid fa-user"></i><span>Нет аватара</span></div>
        </div>

        <label class="checkbox_label">
            <input type="checkbox" id="iig_send_user_avatar" ${settings.sendUserAvatar ? 'checked' : ''}>
            <span>Всегда отправлять аватар юзера</span>
        </label>
        <div id="iig_user_avatar_row" class="flex-row ${!settings.sendUserAvatar ? 'hidden' : ''}" style="margin-top: 5px; align-items: center;">
            <label for="iig_user_avatar_file">Аватар юзера</label>
            <select id="iig_user_avatar_file" class="flex1">
                <option value="">-- Не выбран --</option>
                ${settings.userAvatarFile ? `<option value="${settings.userAvatarFile}" selected>${settings.userAvatarFile}</option>` : ''}
            </select>
            <div id="iig_refresh_avatars" class="menu_button iig-refresh-btn" title="Обновить"><i class="fa-solid fa-sync"></i></div>
        </div>
        <div id="iig_user_avatar_preview" class="iig-avatar-preview-container ${!settings.sendUserAvatar ? 'hidden' : ''}">
            <div class="iig-avatar-preview-empty"><i class="fa-solid fa-user"></i><span>Не выбран</span></div>
        </div>
    `;

    // v2.3: Updated wardrobe section with description panel containers
    const wardrobeSectionContent = `
        <p class="hint">Загрузите картинки с одеждой. Выбранная одежда будет отправлена как референс — модель оденет персонажа в неё. Добавьте текстовое описание (вручную или через AI), чтобы текстовая модель тоже знала об одежде.</p>

        <label class="checkbox_label">
            <input type="checkbox" id="iig_inject_wardrobe" ${settings.injectWardrobeToChat ? 'checked' : ''}>
            <span>Инжектить описание одежды в промпт текстовой модели</span>
        </label>
        <div class="flex-row" style="margin-top: 5px;">
            <label for="iig_wardrobe_injection_depth">Глубина инжекта</label>
            <input type="number" id="iig_wardrobe_injection_depth" class="text_pole flex1" value="${settings.wardrobeInjectionDepth || 1}" min="0" max="10">
        </div>

        <h5 style="margin: 10px 0 4px;">Одежда персонажа</h5>
        <div id="iig_wardrobe_char" class="iig-wardrobe-grid"></div>
        <div class="iig-wardrobe-add-row">
            <input type="text" id="iig_wardrobe_char_name" class="text_pole flex1" placeholder="Название наряда">
            <input type="file" id="iig_wardrobe_char_file" accept="image/*" style="display:none;">
            <div id="iig_wardrobe_char_add" class="menu_button" title="Добавить одежду"><i class="fa-solid fa-plus"></i> Добавить</div>
        </div>

        <h5 style="margin: 14px 0 4px;">Одежда юзера</h5>
        <div id="iig_wardrobe_user" class="iig-wardrobe-grid"></div>
        <div class="iig-wardrobe-add-row">
            <input type="text" id="iig_wardrobe_user_name" class="text_pole flex1" placeholder="Название наряда">
            <input type="file" id="iig_wardrobe_user_file" accept="image/*" style="display:none;">
            <div id="iig_wardrobe_user_add" class="menu_button" title="Добавить одежду"><i class="fa-solid fa-plus"></i> Добавить</div>
        </div>
    `;

    // v2.3: New section for description API settings
    const wardrobeDescApiSectionContent = `
        <p class="hint">Настройте текстовую/vision модель для автоматической генерации описаний одежды по картинке. Если эндпоинт и ключ не указаны, будут использованы основные настройки API (из секции "Настройки API").</p>

        <div class="flex-row">
            <label for="iig_wardrobe_desc_endpoint">Эндпоинт (Vision API)</label>
            <input type="text" id="iig_wardrobe_desc_endpoint" class="text_pole flex1" value="${settings.wardrobeDescEndpoint || ''}" placeholder="https://api.example.com (пусто = основной)">
        </div>
        <div class="flex-row">
            <label for="iig_wardrobe_desc_api_key">API ключ</label>
            <input type="password" id="iig_wardrobe_desc_api_key" class="text_pole flex1" value="${settings.wardrobeDescApiKey || ''}">
            <div id="iig_desc_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть"><i class="fa-solid fa-eye"></i></div>
        </div>
        <div class="flex-row">
            <label for="iig_wardrobe_desc_model">Модель</label>
            <select id="iig_wardrobe_desc_model" class="flex1">
                ${settings.wardrobeDescModel ? `<option value="${settings.wardrobeDescModel}" selected>${settings.wardrobeDescModel}</option>` : '<option value="">-- Выберите --</option>'}
            </select>
            <div id="iig_refresh_desc_models" class="menu_button iig-refresh-btn" title="Обновить список моделей"><i class="fa-solid fa-sync"></i></div>
        </div>
        <div class="flex-col" style="margin-top: 8px;">
            <label for="iig_wardrobe_desc_prompt">Промпт для генерации описания</label>
            <textarea id="iig_wardrobe_desc_prompt" class="text_pole" rows="3" placeholder="Describe this clothing outfit...">${settings.wardrobeDescPrompt || defaultSettings.wardrobeDescPrompt}</textarea>
        </div>
    `;

    const npcSectionContent = `
        <p class="hint">Добавьте NPC с аватарками. При упоминании имени в промпте аватарка будет использована как референс.</p>
        <div id="iig_npc_list"></div>
        <div id="iig_add_npc" class="menu_button" style="width: 100%; margin-top: 8px;">
            <i class="fa-solid fa-plus"></i> Добавить NPC
        </div>
    `;

    const promptsSectionContent = `
        <p class="hint">Positive добавляется в начало, Negative — как инструкция избегания.</p>
        <div class="flex-col" style="margin-bottom: 8px;">
            <label for="iig_positive_prompt">Positive промпт</label>
            <textarea id="iig_positive_prompt" class="text_pole" rows="2" placeholder="masterpiece, best quality...">${settings.positivePrompt || ''}</textarea>
        </div>
        <div class="flex-col" style="margin-bottom: 8px;">
            <label for="iig_negative_prompt">Negative промпт</label>
            <textarea id="iig_negative_prompt" class="text_pole" rows="2" placeholder="low quality, blurry...">${settings.negativePrompt || ''}</textarea>
        </div>
    `;

    const styleSectionContent = `
        <label class="checkbox_label">
            <input type="checkbox" id="iig_fixed_style_enabled" ${settings.fixedStyleEnabled ? 'checked' : ''}>
            <span>Включить фиксированный стиль</span>
        </label>
        <div class="flex-col" style="margin-top: 5px;">
            <label for="iig_fixed_style">Стиль</label>
            <input type="text" id="iig_fixed_style" class="text_pole" value="${settings.fixedStyle || ''}" placeholder="Anime semi-realistic style...">
        </div>
    `;

    const extractionSectionContent = `
        <label class="checkbox_label">
            <input type="checkbox" id="iig_extract_appearance" ${settings.extractAppearance ? 'checked' : ''}>
            <span>Из карточки персонажа</span>
        </label>
        <label class="checkbox_label">
            <input type="checkbox" id="iig_extract_user_appearance" ${settings.extractUserAppearance !== false ? 'checked' : ''}>
            <span>Из персоны юзера</span>
        </label>
        <label class="checkbox_label">
            <input type="checkbox" id="iig_detect_clothing" ${settings.detectClothing ? 'checked' : ''}>
            <span>Определять одежду из чата</span>
        </label>
        <div class="flex-row" style="margin-top: 5px;">
            <label for="iig_clothing_depth">Глубина поиска</label>
            <input type="number" id="iig_clothing_depth" class="text_pole flex1" value="${settings.clothingSearchDepth || 5}" min="1" max="20">
        </div>
    `;

    const errorSectionContent = `
        <div class="flex-row">
            <label for="iig_max_retries">Макс. повторов</label>
            <input type="number" id="iig_max_retries" class="text_pole flex1" value="${settings.maxRetries}" min="0" max="5">
        </div>
        <div class="flex-row">
            <label for="iig_retry_delay">Задержка (мс)</label>
            <input type="number" id="iig_retry_delay" class="text_pole flex1" value="${settings.retryDelay}" min="500" max="10000" step="500">
        </div>
    `;

    const debugSectionContent = `
        <div class="flex-row">
            <div id="iig_export_logs" class="menu_button" style="width: 100%;"><i class="fa-solid fa-download"></i> Экспорт логов</div>
        </div>
    `;

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Генерация картинок</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить генерацию картинок</span>
                    </label>

                    ${createCollapsibleSection('api', '🔌', 'Настройки API', apiSectionContent)}
                    ${createCollapsibleSection('gen_params', '⚙️', 'Параметры генерации', genParamsSectionContent)}
                    ${createCollapsibleSection('references', '🖼️', 'Референсы аватарок', referencesSectionContent)}
                    ${createCollapsibleSection('wardrobe', '👗', 'Гардероб (одежда)', wardrobeSectionContent)}
                    ${createCollapsibleSection('wardrobe_desc_api', '🤖', 'Описание одежды (Vision API)', wardrobeDescApiSectionContent)}
                    ${createCollapsibleSection('npcs', '🎭', 'NPC / Доп. персонажи', npcSectionContent)}
                    ${createCollapsibleSection('prompts', '✍️', 'Пользовательские промпты', promptsSectionContent)}
                    ${createCollapsibleSection('fixed_style', '🎨', 'Фиксированный стиль', styleSectionContent)}
                    ${createCollapsibleSection('extraction', '👤', 'Извлечение внешности и одежды', extractionSectionContent)}
                    ${createCollapsibleSection('errors', '🔄', 'Обработка ошибок', errorSectionContent)}
                    ${createCollapsibleSection('debug', '🐛', 'Отладка', debugSectionContent)}
                </div>
            </div>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', html);

    // Bind collapsible toggles
    document.querySelectorAll('[data-section-toggle]').forEach(header => {
        header.addEventListener('click', () => {
            const sectionId = header.dataset.sectionToggle;
            toggleSectionCollapsed(sectionId);
            const section = header.closest('.iig-section');
            const body = section.querySelector('.iig-section-body');
            const chevron = section.querySelector('.iig-section-chevron');
            body.classList.toggle('iig-section-hidden');
            chevron.classList.toggle('iig-collapsed');
        });
    });

    bindSettingsEvents();
    renderNpcList();
    renderWardrobeGrid('char');
    renderWardrobeGrid('user');
    updateCharAvatarPreview();
    updateUserAvatarPreview();
}

function bindSettingsEvents() {
    const settings = getSettings();

    document.getElementById('iig_enabled')?.addEventListener('change', (e) => { settings.enabled = e.target.checked; saveSettings(); });

    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        settings.apiType = e.target.value; saveSettings();
    });

    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => { settings.endpoint = e.target.value; saveSettings(); });
    document.getElementById('iig_api_key')?.addEventListener('input', (e) => { settings.apiKey = e.target.value; saveSettings(); });

    document.getElementById('iig_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_api_key');
        const icon = document.querySelector('#iig_key_toggle i');
        if (input.type === 'password') { input.type = 'text'; icon.classList.replace('fa-eye', 'fa-eye-slash'); }
        else { input.type = 'password'; icon.classList.replace('fa-eye-slash', 'fa-eye'); }
    });

    document.getElementById('iig_model')?.addEventListener('change', (e) => {
        settings.model = e.target.value; saveSettings();
        if (isGeminiModel(e.target.value)) {
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
        }
    });

    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');
            select.innerHTML = '<option value="">-- Выберите --</option>';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m; opt.textContent = m; opt.selected = m === settings.model;
                select.appendChild(opt);
            }
            toastr.success(`Найдено моделей: ${models.length}`);
        } catch (err) { toastr.error('Ошибка загрузки моделей'); }
        finally { btn.classList.remove('loading'); }
    });

    document.getElementById('iig_size')?.addEventListener('change', (e) => { settings.size = e.target.value; saveSettings(); });
    document.getElementById('iig_quality')?.addEventListener('change', (e) => { settings.quality = e.target.value; saveSettings(); });
    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => { settings.aspectRatio = e.target.value; saveSettings(); });
    document.getElementById('iig_image_size')?.addEventListener('change', (e) => { settings.imageSize = e.target.value; saveSettings(); });
    document.getElementById('iig_auto_detect_names')?.addEventListener('change', (e) => { settings.autoDetectNames = e.target.checked; saveSettings(); });

    document.getElementById('iig_send_char_avatar')?.addEventListener('change', (e) => {
        settings.sendCharAvatar = e.target.checked; saveSettings();
    });

    document.getElementById('iig_send_user_avatar')?.addEventListener('change', (e) => {
        settings.sendUserAvatar = e.target.checked; saveSettings();
        document.getElementById('iig_user_avatar_row')?.classList.toggle('hidden', !e.target.checked);
        document.getElementById('iig_user_avatar_preview')?.classList.toggle('hidden', !e.target.checked);
        if (e.target.checked) updateUserAvatarPreview();
    });

    document.getElementById('iig_user_avatar_file')?.addEventListener('change', (e) => {
        settings.userAvatarFile = e.target.value;
        saveSettings();
        updateUserAvatarPreview();
    });

    document.getElementById('iig_refresh_avatars')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const avatars = await fetchUserAvatars();
            const select = document.getElementById('iig_user_avatar_file');
            select.innerHTML = '<option value="">-- Не выбран --</option>';
            for (const a of avatars) {
                const opt = document.createElement('option');
                opt.value = a; opt.textContent = a; opt.selected = a === settings.userAvatarFile;
                select.appendChild(opt);
            }
            toastr.success(`Найдено аватаров: ${avatars.length}`);
            updateUserAvatarPreview();
        } catch (err) { toastr.error('Ошибка загрузки аватаров'); }
        finally { btn.classList.remove('loading'); }
    });

    document.getElementById('iig_add_npc')?.addEventListener('click', () => { addNpc(); renderNpcList(); toastr.info('NPC добавлен'); });

    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => { settings.maxRetries = parseInt(e.target.value) || 0; saveSettings(); });
    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => { settings.retryDelay = parseInt(e.target.value) || 1000; saveSettings(); });
    document.getElementById('iig_export_logs')?.addEventListener('click', exportLogs);

    document.getElementById('iig_positive_prompt')?.addEventListener('input', (e) => { settings.positivePrompt = e.target.value; saveSettings(); });
    document.getElementById('iig_negative_prompt')?.addEventListener('input', (e) => { settings.negativePrompt = e.target.value; saveSettings(); });
    document.getElementById('iig_fixed_style_enabled')?.addEventListener('change', (e) => { settings.fixedStyleEnabled = e.target.checked; saveSettings(); });
    document.getElementById('iig_fixed_style')?.addEventListener('input', (e) => { settings.fixedStyle = e.target.value; saveSettings(); });
    document.getElementById('iig_extract_appearance')?.addEventListener('change', (e) => { settings.extractAppearance = e.target.checked; saveSettings(); });
    document.getElementById('iig_extract_user_appearance')?.addEventListener('change', (e) => { settings.extractUserAppearance = e.target.checked; saveSettings(); });
    document.getElementById('iig_detect_clothing')?.addEventListener('change', (e) => { settings.detectClothing = e.target.checked; saveSettings(); });
    document.getElementById('iig_clothing_depth')?.addEventListener('input', (e) => { settings.clothingSearchDepth = parseInt(e.target.value) || 5; saveSettings(); });

    // v2.3: Wardrobe injection settings
    document.getElementById('iig_inject_wardrobe')?.addEventListener('change', (e) => {
        settings.injectWardrobeToChat = e.target.checked;
        saveSettings();
        updateWardrobeInjection();
    });

    document.getElementById('iig_wardrobe_injection_depth')?.addEventListener('input', (e) => {
        settings.wardrobeInjectionDepth = parseInt(e.target.value) || 1;
        saveSettings();
        updateWardrobeInjection();
    });

    // v2.3: Wardrobe description API settings
    document.getElementById('iig_wardrobe_desc_endpoint')?.addEventListener('input', (e) => {
        settings.wardrobeDescEndpoint = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_wardrobe_desc_api_key')?.addEventListener('input', (e) => {
        settings.wardrobeDescApiKey = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_desc_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_wardrobe_desc_api_key');
        const icon = document.querySelector('#iig_desc_key_toggle i');
        if (input.type === 'password') { input.type = 'text'; icon.classList.replace('fa-eye', 'fa-eye-slash'); }
        else { input.type = 'password'; icon.classList.replace('fa-eye-slash', 'fa-eye'); }
    });

    document.getElementById('iig_wardrobe_desc_model')?.addEventListener('change', (e) => {
        settings.wardrobeDescModel = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_refresh_desc_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const models = await fetchDescriptionModels();
            const select = document.getElementById('iig_wardrobe_desc_model');
            select.innerHTML = '<option value="">-- Выберите --</option>';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m; opt.textContent = m; opt.selected = m === settings.wardrobeDescModel;
                select.appendChild(opt);
            }
            toastr.success(`Найдено текстовых моделей: ${models.length}`);
        } catch (err) { toastr.error('Ошибка загрузки моделей'); }
        finally { btn.classList.remove('loading'); }
    });

    document.getElementById('iig_wardrobe_desc_prompt')?.addEventListener('input', (e) => {
        settings.wardrobeDescPrompt = e.target.value;
        saveSettings();
    });

    // Wardrobe add buttons
    const bindWardrobeAdd = (target) => {
        const addBtn = document.getElementById(`iig_wardrobe_${target}_add`);
        const fileInput = document.getElementById(`iig_wardrobe_${target}_file`);
        const nameInput = document.getElementById(`iig_wardrobe_${target}_name`);

        addBtn?.addEventListener('click', () => fileInput?.click());
        fileInput?.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onloadend = async () => {
                const resized = await resizeImageBase64(reader.result.split(',')[1], 512);
                const name = nameInput?.value?.trim() || file.name.replace(/\.[^.]+$/, '') || 'Outfit';
                addWardrobeItem(name, resized, target);
                if (nameInput) nameInput.value = '';
                fileInput.value = '';
                renderWardrobeGrid(target);
                toastr.success(`Одежда "${name}" добавлена`);
            };
            reader.readAsDataURL(file);
        });
    };
    bindWardrobeAdd('char');
    bindWardrobeAdd('user');
}

// ============================================================
// INIT
// ============================================================

(function init() {
    const context = SillyTavern.getContext();
    getSettings();

    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        addButtonsToExistingMessages();
        updateWardrobeInjection(); // v2.3: initialize wardrobe injection on load
        console.log('[IIG] Inline Image Generation v2.3 loaded');
    });

    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        setTimeout(() => {
            addButtonsToExistingMessages();
            updateCharAvatarPreview();
            updateWardrobeInjection(); // v2.3: re-inject on chat change
        }, 100);
    });

    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
        await onMessageReceived(messageId);
    });

    console.log('[IIG] Inline Image Generation v2.3 initialized');
})();
