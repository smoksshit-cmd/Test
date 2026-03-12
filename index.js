/**
 * Inline Image Generation Extension for SillyTavern
 * 
 * Catches [IMG:GEN:{json}] tags in AI messages and generates images via configured API.
 * Supports OpenAI-compatible and Gemini-compatible (nano-banana) endpoints.
 */

const MODULE_NAME = 'inline_image_gen';

// Track messages currently being processed to prevent duplicate processing
const processingMessages = new Set();

// Log buffer for debugging
const logBuffer = [];
const MAX_LOG_ENTRIES = 200;

function iigLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const entry = `[${timestamp}] [${level}] ${message}`;
    
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
        logBuffer.shift();
    }
    
    if (level === 'ERROR') {
        console.error('[IIG]', ...args);
    } else if (level === 'WARN') {
        console.warn('[IIG]', ...args);
    } else {
        console.log('[IIG]', ...args);
    }
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
    apiType: 'openai', // 'openai' or 'gemini'
    endpoint: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    quality: 'standard',
    maxRetries: 0, // No auto-retry - user clicks error image to retry manually
    retryDelay: 1000,
    // Reference images (works for both OpenAI and Gemini)
    sendCharAvatar: false,
    sendUserAvatar: false,
    sendPreviousImage: false, // Send last generated image as reference for consistency
    userAvatarFile: '', // Selected user avatar filename from /User Avatars/
    // Style preset - added to every prompt
    defaultStyle: '', // e.g. "semi_realistic, manhwa style, soft lighting"
    // Style reference image (base64) - sent as visual style reference
    styleReferenceImage: '',
    styleReferenceThumb: '', // small thumbnail for UI preview
    // NPC reference avatars [{name: 'NPC Name', file: 'filename.png', source: 'characters|upload', data: ''}]
    npcReferences: [],
    // API presets [{name: 'My API', endpoint: '', apiKey: '', model: '', apiType: 'openai'}]
    apiPresets: [],
    activePreset: '',
    // Gemini/nano-banana specific
    aspectRatio: '1:1', // "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
    imageSize: '1K', // "1K", "2K", "4K"
});

// Image model detection keywords (from your api_client.py)
const IMAGE_MODEL_KEYWORDS = [
    'dall-e', 'midjourney', 'mj', 'journey', 'stable-diffusion', 'sdxl', 'flux',
    'imagen', 'drawing', 'paint', 'image', 'seedream', 'hidream', 'dreamshaper',
    'ideogram', 'nano-banana', 'gpt-image', 'wanx', 'qwen'
];

// Video model keywords to exclude
const VIDEO_MODEL_KEYWORDS = [
    'sora', 'kling', 'jimeng', 'veo', 'pika', 'runway', 'luma',
    'video', 'gen-3', 'minimax', 'cogvideo', 'mochi', 'seedance',
    'vidu', 'wan-ai', 'hunyuan', 'hailuo'
];

// We'll parse tags manually since JSON can contain nested braces
// Tag format: [IMG:GEN:{...json...}] or <img src="[IMG:GEN:{...json...}]">

/**
 * Check if model ID is an image generation model
 */
function isImageModel(modelId) {
    const mid = modelId.toLowerCase();
    
    // Exclude video models
    for (const kw of VIDEO_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return false;
    }
    
    // Exclude vision models
    if (mid.includes('vision') && mid.includes('preview')) return false;
    
    // Check for image model keywords
    for (const kw of IMAGE_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return true;
    }
    
    return false;
}

/**
 * Check if model is Gemini/nano-banana type
 */
function isGeminiModel(modelId) {
    const mid = modelId.toLowerCase();
    return mid.includes('nano-banana');
}

/**
 * Get extension settings
 */
function getSettings() {
    const context = SillyTavern.getContext();
    
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    
    // Ensure all default keys exist
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
            context.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    
    return context.extensionSettings[MODULE_NAME];
}

/**
 * Save settings
 */
function saveSettings() {
    const context = SillyTavern.getContext();
    context.saveSettingsDebounced();
}

/**
 * Fetch models list from endpoint
 */
async function fetchModels() {
    const settings = getSettings();
    
    if (!settings.endpoint || !settings.apiKey) {
        console.warn('[IIG] Cannot fetch models: endpoint or API key not set');
        return [];
    }
    
    const baseUrl = settings.endpoint.replace(/\/$/, '');
    const isGemini = settings.apiType === 'gemini' || baseUrl.includes('googleapis.com');
    
    // Different URL format for Gemini vs OpenAI
    let url;
    let fetchOptions;
    
    if (isGemini) {
        // Google Gemini API uses query parameter for auth
        url = `${baseUrl}/v1beta/models?key=${settings.apiKey}`;
        fetchOptions = { method: 'GET' };
    } else {
        // OpenAI-compatible APIs use Authorization header
        url = `${baseUrl}/v1/models`;
        fetchOptions = {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`
            }
        };
    }
    
    try {
        const response = await fetch(url, fetchOptions);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        let modelIds = [];
        
        if (isGemini) {
            // Gemini format: { models: [{ name: "models/gemini-2.0-flash", ... }] }
            const models = data.models || [];
            modelIds = models.map(m => {
                // Extract model name from "models/gemini-2.0-flash" -> "gemini-2.0-flash"
                const name = m.name || '';
                return name.replace('models/', '');
            });
            // Filter for models that support image generation
            modelIds = modelIds.filter(id => 
                id.includes('image') || 
                id.includes('flash') || 
                id.includes('pro')
            );
        } else {
            // OpenAI format: { data: [{ id: "model-name", ... }] }
            const models = data.data || [];
            modelIds = models.filter(m => isImageModel(m.id)).map(m => m.id);
        }
        
        console.log(`[IIG] Fetched ${modelIds.length} models`);
        return modelIds;
    } catch (error) {
        console.error('[IIG] Failed to fetch models:', error);
        toastr.error(`Ошибка загрузки моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

/**
 * Fetch list of user avatars from /User Avatars/ directory
 */
async function fetchUserAvatars() {
    try {
        const context = SillyTavern.getContext();
        const response = await fetch('/api/avatars/get', {
            method: 'POST',
            headers: context.getRequestHeaders(),
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        return await response.json(); // Returns array of filenames
    } catch (error) {
        console.error('[IIG] Failed to fetch user avatars:', error);
        return [];
    }
}

/**
 * Convert image URL to base64
 */
async function imageUrlToBase64(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                // Remove data URL prefix to get pure base64
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('[IIG] Failed to convert image to base64:', error);
        return null;
    }
}

/**
 * Resize and compress image for use as reference
 * @param {string} base64Data - Base64 image data (without data: prefix)
 * @param {number} maxSize - Maximum width/height in pixels
 * @param {number} quality - JPEG quality 0-1
 * @returns {Promise<string>} - Compressed base64 data
 */
async function compressImageForReference(base64Data, maxSize = 1024, quality = 0.8) {
    return new Promise((resolve, reject) => {
        try {
            const img = new Image();
            img.onload = () => {
                // Calculate new dimensions
                let width = img.width;
                let height = img.height;
                
                if (width > maxSize || height > maxSize) {
                    if (width > height) {
                        height = Math.round(height * maxSize / width);
                        width = maxSize;
                    } else {
                        width = Math.round(width * maxSize / height);
                        height = maxSize;
                    }
                }
                
                // Create canvas and draw resized image
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                
                // Convert to JPEG for smaller size
                const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
                const compressedBase64 = compressedDataUrl.replace('data:image/jpeg;base64,', '');
                
                console.log(`[IIG] Compressed image: ${img.width}x${img.height} -> ${width}x${height}, size: ${Math.round(compressedBase64.length/1024)}KB`);
                resolve(compressedBase64);
            };
            img.onerror = () => reject(new Error('Failed to load image for compression'));
            img.src = `data:image/png;base64,${base64Data}`;
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Save base64 image to file via SillyTavern API
 * @param {string} dataUrl - Data URL (data:image/png;base64,...) or direct URL
 * @returns {Promise<string>} - Relative path to saved file
 */
async function saveImageToFile(dataUrl) {
    const context = SillyTavern.getContext();
    
    console.log('[IIG] saveImageToFile input type:', dataUrl?.substring(0, 50));
    
    // If it's a direct URL (not data:), download and convert
    if (dataUrl && !dataUrl.startsWith('data:') && (dataUrl.startsWith('http://') || dataUrl.startsWith('https://'))) {
        console.log('[IIG] Downloading image from URL...');
        try {
            const response = await fetch(dataUrl);
            const blob = await response.blob();
            const arrayBuffer = await blob.arrayBuffer();
            const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
            const mimeType = blob.type || 'image/png';
            dataUrl = `data:${mimeType};base64,${base64}`;
            console.log('[IIG] Converted URL to data URL, size:', base64.length);
        } catch (err) {
            console.error('[IIG] Failed to download image:', err);
            throw new Error('Failed to download image from URL');
        }
    }
    
    // Extract base64 and format from data URL
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
        console.error('[IIG] Invalid data URL, starts with:', dataUrl?.substring(0, 100));
        throw new Error('Invalid data URL format');
    }
    
    const format = match[1]; // png, jpeg, webp
    const base64Data = match[2];
    
    console.log(`[IIG] Saving image: format=${format}, base64 length=${base64Data.length}`);
    
    // Get character name for subfolder
    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'generated';
    }
    
    // Generate unique filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `iig_${timestamp}`;
    
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            image: base64Data,
            format: format,
            ch_name: charName,
            filename: filename
        })
    });
    
    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error || `Upload failed: ${response.status}`);
    }
    
    const result = await response.json();
    console.log('[IIG] Image saved to:', result.path);
    return result.path;
}

/**
 * Get character avatar as base64
 */
async function getCharacterAvatarBase64() {
    try {
        const context = SillyTavern.getContext();
        
        console.log('[IIG] Getting character avatar, characterId:', context.characterId);
        
        if (context.characterId === undefined || context.characterId === null) {
            console.log('[IIG] No character selected');
            return null;
        }
        
        // Try context method first
        if (typeof context.getCharacterAvatar === 'function') {
            const avatarUrl = context.getCharacterAvatar(context.characterId);
            console.log('[IIG] getCharacterAvatar returned:', avatarUrl);
            if (avatarUrl) {
                return await imageUrlToBase64(avatarUrl);
            }
        }
        
        // Fallback: try to get from characters array
        const character = context.characters?.[context.characterId];
        console.log('[IIG] Character from array:', character?.name, 'avatar:', character?.avatar);
        if (character?.avatar) {
            const avatarUrl = `/characters/${encodeURIComponent(character.avatar)}`;
            console.log('[IIG] Found character avatar:', avatarUrl);
            return await imageUrlToBase64(avatarUrl);
        }
        
        console.log('[IIG] Could not get character avatar');
        return null;
    } catch (error) {
        console.error('[IIG] Error getting character avatar:', error);
        return null;
    }
}

/**
 * Get user avatar as base64 (full resolution, not thumbnail)
 */
async function getUserAvatarBase64() {
    try {
        const settings = getSettings();
        
        // Use selected avatar from settings (user's choice)
        if (!settings.userAvatarFile) {
            console.log('[IIG] No user avatar selected in settings');
            return null;
        }
        
        const avatarUrl = `/User Avatars/${encodeURIComponent(settings.userAvatarFile)}`;
        console.log('[IIG] Using selected user avatar:', avatarUrl);
        return await imageUrlToBase64(avatarUrl);
    } catch (error) {
        console.error('[IIG] Error getting user avatar:', error);
        return null;
    }
}

/**
 * Get NPC reference avatar as base64
 * @param {object} npcRef - NPC reference object {name, file, source, data}
 */
async function getNpcAvatarBase64(npcRef) {
    try {
        if (!npcRef || !npcRef.file) return null;
        
        if (npcRef.source === 'upload' && npcRef.data) {
            // Uploaded image - data is already base64
            console.log(`[IIG] Using uploaded NPC avatar: ${npcRef.name}`);
            return npcRef.data;
        }
        
        // Character avatar from SillyTavern
        const avatarUrl = `/characters/${encodeURIComponent(npcRef.file)}`;
        console.log(`[IIG] Fetching NPC avatar from: ${avatarUrl}`);
        const base64 = await imageUrlToBase64(avatarUrl);
        if (base64) {
            // Compress for reference use
            return await compressImageForReference(base64, 1024, 0.8);
        }
        return null;
    } catch (error) {
        console.error(`[IIG] Error getting NPC avatar for ${npcRef?.name}:`, error);
        return null;
    }
}

/**
 * Get style reference image as base64 (compressed)
 */
async function getStyleReferenceBase64() {
    try {
        const settings = getSettings();
        if (!settings.styleReferenceImage) return null;
        
        console.log('[IIG] Using style reference image');
        // Already stored as base64, just compress if needed
        return await compressImageForReference(settings.styleReferenceImage, 1024, 0.85);
    } catch (error) {
        console.error('[IIG] Error getting style reference:', error);
        return null;
    }
}

/**
 * Convert File object to base64 string (without data: prefix)
 */
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64 = reader.result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/**
 * Create a small thumbnail base64 from full base64 (for settings UI preview)
 */
async function createThumbnail(base64Data, maxSize = 100) {
    return new Promise((resolve, reject) => {
        try {
            const img = new Image();
            img.onload = () => {
                let width = img.width;
                let height = img.height;
                if (width > maxSize || height > maxSize) {
                    if (width > height) {
                        height = Math.round(height * maxSize / width);
                        width = maxSize;
                    } else {
                        width = Math.round(width * maxSize / height);
                        height = maxSize;
                    }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                const thumb = canvas.toDataURL('image/jpeg', 0.7).replace('data:image/jpeg;base64,', '');
                resolve(thumb);
            };
            img.onerror = () => reject(new Error('Failed to create thumbnail'));
            img.src = `data:image/png;base64,${base64Data}`;
        } catch (e) { reject(e); }
    });
}

/**
 * Fetch all character avatars from SillyTavern for NPC selection
 */
async function fetchAllCharacters() {
    try {
        const context = SillyTavern.getContext();
        const characters = context.characters || [];
        return characters.map(c => ({
            name: c.name,
            avatar: c.avatar
        })).filter(c => c.avatar);
    } catch (error) {
        console.error('[IIG] Failed to fetch characters:', error);
        return [];
    }
}

/**
 * Load API preset into current settings
 */
function loadApiPreset(presetName) {
    const settings = getSettings();
    const preset = settings.apiPresets.find(p => p.name === presetName);
    if (!preset) return false;
    
    settings.endpoint = preset.endpoint || '';
    settings.apiKey = preset.apiKey || '';
    settings.model = preset.model || '';
    settings.apiType = preset.apiType || 'openai';
    settings.activePreset = presetName;
    saveSettings();
    
    // Update UI fields
    const elEndpoint = document.getElementById('iig_endpoint');
    const elApiKey = document.getElementById('iig_api_key');
    const elModel = document.getElementById('iig_model');
    const elApiType = document.getElementById('iig_api_type');
    
    if (elEndpoint) elEndpoint.value = settings.endpoint;
    if (elApiKey) elApiKey.value = settings.apiKey;
    if (elModel) {
        elModel.innerHTML = settings.model 
            ? `<option value="${settings.model}" selected>${settings.model}</option>` 
            : '<option value="">-- Выберите модель --</option>';
    }
    if (elApiType) {
        elApiType.value = settings.apiType;
        const geminiSection = document.getElementById('iig_gemini_section');
        if (geminiSection) geminiSection.classList.toggle('hidden', settings.apiType !== 'gemini');
    }
    
    iigLog('INFO', `Loaded API preset: ${presetName}`);
    toastr.success(`Пресет "${presetName}" загружен`, 'Генерация картинок');
    return true;
}

/**
 * Save current API settings as a preset
 */
function saveApiPreset(name) {
    if (!name || !name.trim()) return false;
    name = name.trim();
    
    const settings = getSettings();
    const existing = settings.apiPresets.findIndex(p => p.name === name);
    
    const preset = {
        name: name,
        endpoint: settings.endpoint,
        apiKey: settings.apiKey,
        model: settings.model,
        apiType: settings.apiType
    };
    
    if (existing >= 0) {
        settings.apiPresets[existing] = preset;
    } else {
        settings.apiPresets.push(preset);
    }
    
    settings.activePreset = name;
    saveSettings();
    
    iigLog('INFO', `Saved API preset: ${name}`);
    toastr.success(`Пресет "${name}" сохранён`, 'Генерация картинок');
    return true;
}

/**
 * Delete an API preset
 */
function deleteApiPreset(name) {
    const settings = getSettings();
    settings.apiPresets = settings.apiPresets.filter(p => p.name !== name);
    if (settings.activePreset === name) settings.activePreset = '';
    saveSettings();
    iigLog('INFO', `Deleted API preset: ${name}`);
    toastr.success(`Пресет "${name}" удалён`, 'Генерация картинок');
}

/**
 * Refresh the preset dropdown UI
 */
function refreshPresetDropdown() {
    const settings = getSettings();
    const select = document.getElementById('iig_api_preset');
    if (!select) return;
    
    select.innerHTML = '<option value="">-- Без пресета --</option>';
    for (const preset of settings.apiPresets) {
        const opt = document.createElement('option');
        opt.value = preset.name;
        opt.textContent = preset.name;
        opt.selected = preset.name === settings.activePreset;
        select.appendChild(opt);
    }
}

/**
 * Get last generated image from chat as base64 (compressed for reference use)
 * Searches backwards through messages to find the most recent iig-generated image
 */
async function getLastGeneratedImageBase64(currentMessageId = null) {
    try {
        const context = SillyTavern.getContext();
        const chat = context.chat || [];
        
        // Search backwards through messages
        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];
            
            // Skip current message if specified
            if (currentMessageId !== null && i === currentMessageId) {
                continue;
            }
            
            const mes = message.mes || '';
            
            // Look for our generated images (they have paths like /user/images/...)
            const imgMatch = mes.match(/src=["']?(\/user\/images\/[^"'\s>]+)/i);
            if (imgMatch) {
                const imagePath = imgMatch[1];
                console.log('[IIG] Found previous generated image:', imagePath);
                
                // Convert to base64
                const rawBase64 = await imageUrlToBase64(imagePath);
                if (!rawBase64) return null;
                
                // Compress for reference use (max 1024px, 80% quality)
                // This reduces 3MB images to ~100-200KB
                console.log(`[IIG] Original previous image size: ${Math.round(rawBase64.length/1024)}KB, compressing...`);
                const compressed = await compressImageForReference(rawBase64, 1024, 0.8);
                return compressed;
            }
        }
        
        console.log('[IIG] No previous generated images found in chat');
        return null;
    } catch (error) {
        console.error('[IIG] Error getting last generated image:', error);
        return null;
    }
}

/**
 * Generate image via OpenAI-compatible endpoint
 */
async function generateImageOpenAI(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/images/generations`;
    
    // Combine style and prompt
    const fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    
    // Map aspect ratio to size if provided in tag
    // Using sizes compatible with most providers (VoidAI, etc.)
    let size = settings.size;
    if (options.aspectRatio) {
        if (options.aspectRatio === '16:9' || options.aspectRatio === '3:2') size = '1536x1024';
        else if (options.aspectRatio === '9:16' || options.aspectRatio === '2:3') size = '1024x1536';
        else if (options.aspectRatio === '1:1') size = '1024x1024';
        else size = 'auto'; // fallback для нестандартных соотношений
    }
    
    // Detect model type for parameter compatibility
    const modelLower = (settings.model || '').toLowerCase();
    const isDallE = modelLower.includes('dall-e') || modelLower.includes('dalle');
    const isGptImage = modelLower.includes('gpt-image');
    const isFlux = modelLower.includes('flux');
    const isImagen = modelLower.includes('imagen');
    
    // Build request body
    const body = {
        model: settings.model,
        prompt: fullPrompt,
        n: 1
    };
    
    // Size - add for most models
    if (size && size !== 'auto') {
        body.size = size;
    }
    
    // Response format - request base64 for easier handling
    // Note: Some providers may ignore this or return URL anyway
    body.response_format = 'b64_json';
    
    // Reference images - DISABLED for standard /generations endpoint
    // This endpoint doesn't support img2img, only text-to-image
    // Reference images would need /edits endpoint or provider-specific API
    if (referenceImages.length > 0) {
        console.log('[IIG] Reference images collected but NOT sent (/generations endpoint is text-to-image only)');
    }
    
    // Log request details for debugging
    console.log('[IIG] OpenAI Request:', {
        url: url,
        model: body.model,
        size: body.size || 'not set',
        quality: body.quality || 'not set',
        response_format: body.response_format || 'not set',
        promptLength: fullPrompt.length,
        bodyKeys: Object.keys(body)
    });
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error (${response.status}): ${text}`);
    }
    
    const result = await response.json();
    
    console.log('[IIG] OpenAI API response structure:', Object.keys(result));
    
    // Parse response - handle different formats
    // Standard OpenAI: { data: [{ b64_json: "..." }] }
    // VoidAI might: { data: [{ b64_json: "..." }] } or { images: [...] } or { url: "..." }
    
    const dataList = result.data || result.images || [];
    
    if (dataList.length === 0) {
        // Try direct url/image field
        if (result.url) return result.url;
        if (result.image) {
            // Some APIs return raw base64 in 'image' field
            if (result.image.startsWith('data:')) return result.image;
            return `data:image/png;base64,${result.image}`;
        }
        if (result.b64_json) {
            return `data:image/png;base64,${result.b64_json}`;
        }
        console.error('[IIG] Full response:', JSON.stringify(result).substring(0, 500));
        throw new Error('No image data in response');
    }
    
    const imageObj = dataList[0];
    console.log('[IIG] Image object keys:', Object.keys(imageObj));
    
    // Handle different field names
    const b64Data = imageObj.b64_json || imageObj.b64 || imageObj.base64 || imageObj.image;
    const urlData = imageObj.url || imageObj.uri;
    
    if (b64Data) {
        // Check if it already has data: prefix
        if (b64Data.startsWith('data:')) {
            return b64Data;
        }
        // Detect image format from base64 header
        let mimeType = 'image/png';
        if (b64Data.startsWith('/9j/')) mimeType = 'image/jpeg';
        else if (b64Data.startsWith('R0lGOD')) mimeType = 'image/gif';
        else if (b64Data.startsWith('UklGR')) mimeType = 'image/webp';
        
        console.log(`[IIG] Image mime type detected: ${mimeType}, data length: ${b64Data.length}`);
        return `data:${mimeType};base64,${b64Data}`;
    }
    
    if (urlData) {
        console.log('[IIG] Got URL instead of base64:', urlData.substring(0, 100));
        return urlData;
    }
    
    console.error('[IIG] Unexpected image object structure:', JSON.stringify(imageObj).substring(0, 300));
    throw new Error('Unexpected image response format');
}

// Valid aspect ratios for Gemini/nano-banana
const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
// Valid image sizes for Gemini/nano-banana
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];

/**
 * Generate image via Gemini-compatible endpoint (nano-banana)
 */
async function generateImageGemini(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const model = settings.model;
    const baseUrl = settings.endpoint.replace(/\/$/, '');
    const isGoogleApi = baseUrl.includes('googleapis.com');
    
    // Google API uses query param for key, other Gemini-compatible APIs use header
    const url = isGoogleApi 
        ? `${baseUrl}/v1beta/models/${model}:generateContent?key=${settings.apiKey}`
        : `${baseUrl}/v1beta/models/${model}:generateContent`;
    
    // Determine aspect ratio: tag option > settings, with validation
    let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) {
        iigLog('WARN', `Invalid aspect_ratio "${aspectRatio}", falling back to settings or default`);
        aspectRatio = VALID_ASPECT_RATIOS.includes(settings.aspectRatio) ? settings.aspectRatio : '1:1';
    }
    
    // Determine image size: tag option > settings, with validation
    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) {
        iigLog('WARN', `Invalid image_size "${imageSize}", falling back to settings or default`);
        imageSize = VALID_IMAGE_SIZES.includes(settings.imageSize) ? settings.imageSize : '1K';
    }
    
    iigLog('INFO', `Using aspect ratio: ${aspectRatio}, image size: ${imageSize}`);
    
    // Build parts array
    const parts = [];
    
    // Add reference images first (up to 4)
    for (const imgB64 of referenceImages.slice(0, 4)) {
        parts.push({
            inlineData: {
                mimeType: 'image/png',
                data: imgB64
            }
        });
    }
    
    // Add prompt with style and reference instruction
    let fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    
    // If reference images provided, add instruction to copy appearance
    if (referenceImages.length > 0) {
        const settings = getSettings();
        const hasStyleRef = !!settings.styleReferenceImage;
        const hasNpcRefs = settings.npcReferences && settings.npcReferences.length > 0;
        
        let refInstruction = '[CRITICAL: The reference image(s) above show the EXACT appearance of the character(s). You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features. Do not deviate from the reference appearances.]';
        
        if (hasStyleRef) {
            refInstruction += '\n[STYLE REFERENCE: One of the reference images above defines the TARGET ART STYLE. You MUST match its art style, color palette, rendering technique, line work, shading method, and overall aesthetic. Generate the new image in the exact same visual style.]';
        }
        
        if (hasNpcRefs) {
            const npcNames = settings.npcReferences.filter(n => n.file || n.data).map(n => n.name).join(', ');
            refInstruction += `\n[NPC REFERENCES: Reference images include NPC characters: ${npcNames}. If these characters appear in the scene, use their exact appearance from the references.]`;
        }
        
        fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
    }
    
    parts.push({ text: fullPrompt });
    
    console.log(`[IIG] Gemini request: ${referenceImages.length} reference image(s) + prompt (${fullPrompt.length} chars)`);
    
    const body = {
        contents: [{
            role: 'user',
            parts: parts
        }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {
                aspectRatio: aspectRatio,
                imageSize: imageSize
            }
        }
    };
    
    // Log full request config for debugging 400 errors
    iigLog('INFO', `Gemini request config: model=${model}, aspectRatio=${aspectRatio}, imageSize=${imageSize}, promptLength=${fullPrompt.length}, refImages=${referenceImages.length}`);
    
    // Build headers - Google API uses query param for auth, others use Authorization header
    const headers = { 'Content-Type': 'application/json' };
    if (!isGoogleApi) {
        headers['Authorization'] = `Bearer ${settings.apiKey}`;
    }
    
    const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body)
    });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error (${response.status}): ${text}`);
    }
    
    const result = await response.json();
    
    // Parse Gemini response
    const candidates = result.candidates || [];
    if (candidates.length === 0) {
        throw new Error('No candidates in response');
    }
    
    const responseParts = candidates[0].content?.parts || [];
    
    for (const part of responseParts) {
        // Check both camelCase and snake_case variants
        if (part.inlineData) {
            return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        }
        if (part.inline_data) {
            return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
        }
    }
    
    throw new Error('No image found in Gemini response');
}

/**
 * Validate settings before generation
 */
function validateSettings() {
    const settings = getSettings();
    const errors = [];
    
    if (!settings.endpoint) {
        errors.push('URL эндпоинта не настроен');
    }
    if (!settings.apiKey) {
        errors.push('API ключ не настроен');
    }
    if (!settings.model) {
        errors.push('Модель не выбрана');
    }
    
    if (errors.length > 0) {
        throw new Error(`Ошибка настроек: ${errors.join(', ')}`);
    }
}

/**
 * Sanitize text for safe HTML display
 */
function sanitizeForHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Generate image with retry logic
 * @param {string} prompt - Image description
 * @param {string} style - Style tag
 * @param {function} onStatusUpdate - Status callback
 * @param {object} options - Additional options (aspectRatio, quality)
 */
async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    // Validate settings first
    validateSettings();
    
    const settings = getSettings();
    const maxRetries = settings.maxRetries;
    const baseDelay = settings.retryDelay;
    
    // Collect reference images if enabled (works for both OpenAI and Gemini)
    const referenceImages = [];
    
    if (settings.sendCharAvatar) {
        console.log('[IIG] Fetching character avatar for reference...');
        const charAvatar = await getCharacterAvatarBase64();
        if (charAvatar) {
            referenceImages.push(charAvatar);
            console.log('[IIG] Character avatar added to references');
        }
    }
    
    if (settings.sendUserAvatar) {
        console.log('[IIG] Fetching user avatar for reference...');
        const userAvatar = await getUserAvatarBase64();
        if (userAvatar) {
            referenceImages.push(userAvatar);
            console.log('[IIG] User avatar added to references');
        }
    }
    
    if (settings.sendPreviousImage) {
        console.log('[IIG] Fetching previous generated image for reference...');
        const prevImage = await getLastGeneratedImageBase64();
        if (prevImage) {
            referenceImages.push(prevImage);
            console.log('[IIG] Previous image added to references');
        }
    }
    
    // NPC reference avatars
    if (settings.npcReferences && settings.npcReferences.length > 0) {
        for (const npcRef of settings.npcReferences) {
            if (!npcRef.file && !npcRef.data) continue;
            console.log(`[IIG] Fetching NPC avatar: ${npcRef.name}...`);
            const npcAvatar = await getNpcAvatarBase64(npcRef);
            if (npcAvatar) {
                referenceImages.push(npcAvatar);
                console.log(`[IIG] NPC avatar "${npcRef.name}" added to references`);
            }
        }
    }
    
    // Style reference image
    const styleRef = await getStyleReferenceBase64();
    if (styleRef) {
        referenceImages.push(styleRef);
        console.log('[IIG] Style reference image added to references');
    }
    
    console.log(`[IIG] Total reference images: ${referenceImages.length}`);
    
    // Add default style to the style parameter if set
    let finalStyle = style || '';
    if (settings.defaultStyle) {
        finalStyle = settings.defaultStyle + (finalStyle ? ', ' + finalStyle : '');
        console.log(`[IIG] Using default style: ${settings.defaultStyle}`);
    }
    
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            onStatusUpdate?.(`Генерация${attempt > 0 ? ` (повтор ${attempt}/${maxRetries})` : ''}...`);
            
            // Choose API based on type or model
            if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
                return await generateImageGemini(prompt, finalStyle, referenceImages, options);
            } else {
                return await generateImageOpenAI(prompt, finalStyle, referenceImages, options);
            }
        } catch (error) {
            lastError = error;
            console.error(`[IIG] Generation attempt ${attempt + 1} failed:`, error);
            
            // Check if retryable
            const isRetryable = error.message?.includes('429') ||
                               error.message?.includes('503') ||
                               error.message?.includes('502') ||
                               error.message?.includes('504') ||
                               error.message?.includes('timeout') ||
                               error.message?.includes('network');
            
            if (!isRetryable || attempt === maxRetries) {
                break;
            }
            
            const delay = baseDelay * Math.pow(2, attempt);
            onStatusUpdate?.(`Повтор через ${delay / 1000}с...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    throw lastError;
}

/**
 * Check if a file exists on the server
 */
async function checkFileExists(path) {
    try {
        const response = await fetch(path, { method: 'HEAD' });
        return response.ok;
    } catch (e) {
        return false;
    }
}

/**
 * Parse image generation tags from message text
 * Supports two formats:
 * 1. NEW: <img data-iig-instruction='{"style":"...","prompt":"..."}' src="[IMG:GEN]">
 * 2. LEGACY: [IMG:GEN:{"style":"...","prompt":"..."}]
 * 
 * @param {string} text - Message text
 * @param {object} options - Options
 * @param {boolean} options.checkExistence - Check if image files exist (for hallucination detection)
 * @param {boolean} options.forceAll - Include all instruction tags even with valid paths (for regeneration)
 */
async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];
    
    // === NEW FORMAT: <img data-iig-instruction="{...}" src="[IMG:GEN]"> ===
    // LLM often generates broken HTML with unescaped quotes, so we parse manually
    const imgTagMarker = 'data-iig-instruction=';
    let searchPos = 0;
    
    while (true) {
        const markerPos = text.indexOf(imgTagMarker, searchPos);
        if (markerPos === -1) break;
        
        // Find the start of the <img tag
        let imgStart = text.lastIndexOf('<img', markerPos);
        if (imgStart === -1 || markerPos - imgStart > 500) {
            searchPos = markerPos + 1;
            continue;
        }
        
        // Find the JSON start (first { after the marker)
        const afterMarker = markerPos + imgTagMarker.length;
        let jsonStart = text.indexOf('{', afterMarker);
        if (jsonStart === -1 || jsonStart > afterMarker + 10) {
            searchPos = markerPos + 1;
            continue;
        }
        
        // Find matching closing brace using brace counting
        let braceCount = 0;
        let jsonEnd = -1;
        let inString = false;
        let escapeNext = false;
        
        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];
            
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            
            if (char === '\\' && inString) {
                escapeNext = true;
                continue;
            }
            
            if (char === '"') {
                inString = !inString;
                continue;
            }
            
            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEnd = i + 1;
                        break;
                    }
                }
            }
        }
        
        if (jsonEnd === -1) {
            searchPos = markerPos + 1;
            continue;
        }
        
        // Find the end of the <img> tag
        let imgEnd = text.indexOf('>', jsonEnd);
        if (imgEnd === -1) {
            searchPos = markerPos + 1;
            continue;
        }
        imgEnd++; // Include the >
        
        const fullImgTag = text.substring(imgStart, imgEnd);
        const instructionJson = text.substring(jsonStart, jsonEnd);
        
        // Check if src needs generation
        const srcMatch = fullImgTag.match(/src\s*=\s*["']?([^"'\s>]+)/i);
        const srcValue = srcMatch ? srcMatch[1] : '';
        
        // Determine if this needs generation
        let needsGeneration = false;
        const hasMarker = srcValue.includes('[IMG:GEN]') || srcValue.includes('[IMG:');
        const hasErrorImage = srcValue.includes('error.svg'); // Our error placeholder - NO auto-retry
        const hasPath = srcValue && srcValue.startsWith('/') && srcValue.length > 5;
        
        // Skip error images - user must click to retry manually (prevents conflict on swipe)
        if (hasErrorImage && !forceAll) {
            iigLog('INFO', `Skipping error image (click to retry): ${srcValue.substring(0, 50)}`);
            searchPos = imgEnd;
            continue;
        }
        
        if (forceAll) {
            // Regeneration mode: include all tags with instruction (user-triggered)
            needsGeneration = true;
            iigLog('INFO', `Force regeneration mode: including ${srcValue.substring(0, 30)}`);
        } else if (hasMarker || !srcValue) {
            // Explicit marker or empty src = needs generation
            needsGeneration = true;
        } else if (hasPath && checkExistence) {
            // Has a path - check if file actually exists
            const exists = await checkFileExists(srcValue);
            if (!exists) {
                // File doesn't exist = LLM hallucinated the path
                iigLog('WARN', `File does not exist (LLM hallucination?): ${srcValue}`);
                needsGeneration = true;
            } else {
                iigLog('INFO', `Skipping existing image: ${srcValue.substring(0, 50)}`);
            }
        } else if (hasPath) {
            // Has path but not checking existence - skip
            iigLog('INFO', `Skipping path (no existence check): ${srcValue.substring(0, 50)}`);
            searchPos = imgEnd;
            continue;
        }
        
        if (!needsGeneration) {
            searchPos = imgEnd;
            continue;
        }
        
        try {
            // Normalize JSON: AI sometimes uses single quotes, HTML entities, etc.
            let normalizedJson = instructionJson
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'")
                .replace(/&#39;/g, "'")
                .replace(/&#34;/g, '"')
                .replace(/&amp;/g, '&');
            
            const data = JSON.parse(normalizedJson);
            
            tags.push({
                fullMatch: fullImgTag,
                index: imgStart,
                style: data.style || '',
                prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: true,
                existingSrc: hasPath ? srcValue : null // Store existing src for logging
            });
            
            iigLog('INFO', `Found NEW format tag: ${data.prompt?.substring(0, 50)}`);
        } catch (e) {
            iigLog('WARN', `Failed to parse instruction JSON: ${instructionJson.substring(0, 100)}`, e.message);
        }
        
        searchPos = imgEnd;
    }
    
    // === LEGACY FORMAT: [IMG:GEN:{...}] ===
    const marker = '[IMG:GEN:';
    let searchStart = 0;
    
    while (true) {
        const markerIndex = text.indexOf(marker, searchStart);
        if (markerIndex === -1) break;
        
        const jsonStart = markerIndex + marker.length;
        
        // Find the matching closing brace for JSON
        let braceCount = 0;
        let jsonEnd = -1;
        let inString = false;
        let escapeNext = false;
        
        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];
            
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            
            if (char === '\\' && inString) {
                escapeNext = true;
                continue;
            }
            
            if (char === '"') {
                inString = !inString;
                continue;
            }
            
            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEnd = i + 1;
                        break;
                    }
                }
            }
        }
        
        if (jsonEnd === -1) {
            searchStart = jsonStart;
            continue;
        }
        
        const jsonStr = text.substring(jsonStart, jsonEnd);
        
        const afterJson = text.substring(jsonEnd);
        if (!afterJson.startsWith(']')) {
            searchStart = jsonEnd;
            continue;
        }
        
        const tagOnly = text.substring(markerIndex, jsonEnd + 1);
        
        try {
            const normalizedJson = jsonStr.replace(/'/g, '"');
            const data = JSON.parse(normalizedJson);
            
            tags.push({
                fullMatch: tagOnly,
                index: markerIndex,
                style: data.style || '',
                prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: false
            });
            
            iigLog('INFO', `Found LEGACY format tag: ${data.prompt?.substring(0, 50)}`);
        } catch (e) {
            iigLog('WARN', `Failed to parse legacy tag JSON: ${jsonStr.substring(0, 100)}`, e.message);
        }
        
        searchStart = jsonEnd + 1;
    }
    
    return tags;
}

/**
 * Create loading placeholder element
 */
function createLoadingPlaceholder(tagId) {
    const placeholder = document.createElement('div');
    placeholder.className = 'iig-loading-placeholder';
    placeholder.dataset.tagId = tagId;
    placeholder.innerHTML = `
        <div class="iig-spinner"></div>
        <div class="iig-status">Генерация картинки...</div>
    `;
    return placeholder;
}

// Error image path - served from extension folder
const ERROR_IMAGE_PATH = '/scripts/extensions/third-party/sillyimages/error.svg';

/**
 * Create error placeholder element - just shows error.svg, no click handlers
 * User uses the regenerate button in message menu to retry
 */
function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = ERROR_IMAGE_PATH;
    img.alt = 'Ошибка генерации';
    img.title = `Ошибка: ${errorMessage}`;
    img.dataset.tagId = tagId;
    
    // Preserve data-iig-instruction for regenerate button functionality
    if (tagInfo.fullMatch) {
        const instructionMatch = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (instructionMatch) {
            img.setAttribute('data-iig-instruction', instructionMatch[2]);
        }
    }
    
    return img;
}

/**
 * Process image tags in a message
 */
async function processMessageTags(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    
    if (!settings.enabled) return;
    
    // Prevent duplicate processing
    if (processingMessages.has(messageId)) {
        iigLog('WARN', `Message ${messageId} is already being processed, skipping`);
        return;
    }
    
    const message = context.chat[messageId];
    if (!message || message.is_user) return;
    
    // Check for tags, with file existence check to catch LLM hallucinations
    const tags = await parseImageTags(message.mes, { checkExistence: true });
    iigLog('INFO', `parseImageTags returned: ${tags.length} tags`);
    if (tags.length > 0) {
        iigLog('INFO', `First tag: ${JSON.stringify(tags[0]).substring(0, 200)}`);
    }
    if (tags.length === 0) {
        iigLog('INFO', 'No tags found by parser');
        return;
    }
    
    // Mark as processing
    processingMessages.add(messageId);
    iigLog('INFO', `Found ${tags.length} image tag(s) in message ${messageId}`);
    toastr.info(`Найдено тегов: ${tags.length}. Генерация...`, 'Генерация картинок', { timeOut: 3000 });
    
    // DOM is ready because we use CHARACTER_MESSAGE_RENDERED event
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) {
        console.error('[IIG] Message element not found for ID:', messageId);
        toastr.error('Не удалось найти элемент сообщения', 'Генерация картинок');
        return;
    }
    
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) return;
    
    // Process each tag in parallel
    const processTag = async (tag, index) => {
        const tagId = `iig-${messageId}-${index}`;
        
        iigLog('INFO', `Processing tag ${index}: ${tag.fullMatch.substring(0, 50)}`);
        
        // Create loading placeholder
        const loadingPlaceholder = createLoadingPlaceholder(tagId);
        let targetElement = null;
        
        if (tag.isNewFormat) {
            // NEW FORMAT: <img data-iig-instruction='...'> is a real DOM element
            // Find it by looking for img with data-iig-instruction attribute
            const allImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
            iigLog('INFO', `Searching for img element. Found ${allImgs.length} img[data-iig-instruction] elements in DOM`);
            
            // Debug: log what we're looking for vs what's in DOM
            const searchPrompt = tag.prompt.substring(0, 30);
            iigLog('INFO', `Searching for prompt starting with: "${searchPrompt}"`);
            
            for (const img of allImgs) {
                const instruction = img.getAttribute('data-iig-instruction');
                const src = img.getAttribute('src') || '';
                iigLog('INFO', `DOM img - src: "${src.substring(0, 50)}", instruction (first 100): "${instruction?.substring(0, 100)}"`);
                
                // Try multiple matching strategies
                if (instruction) {
                    // Strategy 1: Decode HTML entities and normalize quotes, then match
                    const decodedInstruction = instruction
                        .replace(/&quot;/g, '"')
                        .replace(/&apos;/g, "'")
                        .replace(/&#39;/g, "'")
                        .replace(/&#34;/g, '"')
                        .replace(/&amp;/g, '&');
                    
                    // Also normalize the search prompt the same way
                    const normalizedSearchPrompt = searchPrompt
                        .replace(/&quot;/g, '"')
                        .replace(/&apos;/g, "'")
                        .replace(/&#39;/g, "'")
                        .replace(/&#34;/g, '"')
                        .replace(/&amp;/g, '&');
                    
                    // Check if decoded instruction contains the prompt
                    if (decodedInstruction.includes(normalizedSearchPrompt)) {
                        iigLog('INFO', `Found img element via decoded instruction match`);
                        targetElement = img;
                        break;
                    }
                    
                    // Strategy 2: Try to parse the instruction as JSON and compare prompts
                    try {
                        const normalizedJson = decodedInstruction.replace(/'/g, '"');
                        const instructionData = JSON.parse(normalizedJson);
                        if (instructionData.prompt && instructionData.prompt.substring(0, 30) === tag.prompt.substring(0, 30)) {
                            iigLog('INFO', `Found img element via JSON prompt match`);
                            targetElement = img;
                            break;
                        }
                    } catch (e) {
                        // JSON parse failed, continue with other strategies
                    }
                    
                    // Strategy 3: Raw instruction contains raw search prompt (original approach)
                    if (instruction.includes(searchPrompt)) {
                        iigLog('INFO', `Found img element via raw instruction match`);
                        targetElement = img;
                        break;
                    }
                }
            }
            
            // Alternative: find by src containing markers (when prompt matching fails)
            if (!targetElement) {
                iigLog('INFO', `Prompt matching failed, trying src marker matching...`);
                for (const img of allImgs) {
                    const src = img.getAttribute('src') || '';
                    // Check for generation markers or empty/broken src
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]') || src === '' || src === '#') {
                        iigLog('INFO', `Found img element with generation marker in src: "${src}"`);
                        targetElement = img;
                        break;
                    }
                }
            }
            
            // Strategy 4: If still not found, try looking at ALL imgs (not just those with data-iig-instruction attr)
            // This handles cases where browser didn't parse data-iig-instruction as a valid attribute
            if (!targetElement) {
                iigLog('INFO', `Trying broader img search...`);
                const allImgsInMes = mesTextEl.querySelectorAll('img');
                for (const img of allImgsInMes) {
                    const src = img.getAttribute('src') || '';
                    // Look for src containing our markers
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) {
                        iigLog('INFO', `Found img via broad search with marker src: "${src.substring(0, 50)}"`);
                        targetElement = img;
                        break;
                    }
                }
            }
        } else {
            // LEGACY FORMAT: [IMG:GEN:{...}] - use regex replacement
            const tagEscaped = tag.fullMatch
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                .replace(/"/g, '(?:"|&quot;)');
            const tagRegex = new RegExp(tagEscaped, 'g');
            
            const beforeReplace = mesTextEl.innerHTML;
            mesTextEl.innerHTML = mesTextEl.innerHTML.replace(
                tagRegex,
                `<span data-iig-placeholder="${tagId}"></span>`
            );
            
            if (beforeReplace !== mesTextEl.innerHTML) {
                targetElement = mesTextEl.querySelector(`[data-iig-placeholder="${tagId}"]`);
                iigLog('INFO', `Legacy tag replaced with placeholder span`);
            }
            
            // Also check for img src containing legacy tag
            if (!targetElement) {
                const allImgs = mesTextEl.querySelectorAll('img');
                for (const img of allImgs) {
                    if (img.src && img.src.includes('[IMG:GEN:')) {
                        targetElement = img;
                        iigLog('INFO', `Found img with legacy tag in src`);
                        break;
                    }
                }
            }
        }
        
        // Replace target with placeholder, preserving parent styling context
        if (targetElement) {
            // Copy some styling context from parent for adaptive placeholder
            const parent = targetElement.parentElement;
            if (parent) {
                const parentStyle = window.getComputedStyle(parent);
                if (parentStyle.display === 'flex' || parentStyle.display === 'grid') {
                    loadingPlaceholder.style.alignSelf = 'center';
                }
            }
            targetElement.replaceWith(loadingPlaceholder);
            iigLog('INFO', `Loading placeholder shown (replaced target element)`);
        } else {
            iigLog('WARN', `Could not find target element, appending placeholder as fallback`);
            mesTextEl.appendChild(loadingPlaceholder);
        }
        
        const statusEl = loadingPlaceholder.querySelector('.iig-status');
        
        try {
            const dataUrl = await generateImageWithRetry(
                tag.prompt,
                tag.style,
                (status) => { statusEl.textContent = status; },
                { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality }
            );
            
            // Save image to file instead of keeping base64
            statusEl.textContent = 'Сохранение...';
            const imagePath = await saveImageToFile(dataUrl);
            
            // Replace placeholder with actual image
            const img = document.createElement('img');
            img.className = 'iig-generated-image';
            img.src = imagePath;
            img.alt = tag.prompt;
            img.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;
            
            // Preserve instruction for future regenerations (new format only)
            if (tag.isNewFormat) {
                const instructionMatch = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
                if (instructionMatch) {
                    img.setAttribute('data-iig-instruction', instructionMatch[2]);
                }
            }
            
            loadingPlaceholder.replaceWith(img);
            
            // Update message.mes to persist the image
            if (tag.isNewFormat) {
                // NEW FORMAT: <img data-iig-instruction="..." src="[IMG:GEN]">
                // Just update the src attribute with the real path
                // LLM sees same format but with real path = already generated
                const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
                message.mes = message.mes.replace(tag.fullMatch, updatedTag);
            } else {
                // LEGACY FORMAT: [IMG:GEN:{...}]
                // Replace with completion marker so LLM doesn't copy it
                const completionMarker = `[IMG:✓:${imagePath}]`;
                message.mes = message.mes.replace(tag.fullMatch, completionMarker);
            }
            
            iigLog('INFO', `Successfully generated image for tag ${index}`);
            toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Failed to generate image for tag ${index}:`, error.message);
            
            // Replace with error placeholder
            const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag);
            loadingPlaceholder.replaceWith(errorPlaceholder);
            
            // IMPORTANT: Mark tag as failed in message.mes - use error.svg path so it displays properly after swipe
            if (tag.isNewFormat) {
                // NEW FORMAT: update src with error image path (will be detected for retry)
                const errorTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${ERROR_IMAGE_PATH}"`);
                message.mes = message.mes.replace(tag.fullMatch, errorTag);
            } else {
                // LEGACY FORMAT: replace with error marker
                const errorMarker = `[IMG:ERROR:${error.message.substring(0, 50)}]`;
                message.mes = message.mes.replace(tag.fullMatch, errorMarker);
            }
            iigLog('INFO', `Marked tag as failed in message.mes`);
            
            toastr.error(`Ошибка генерации: ${error.message}`, 'Генерация картинок');
        }
    };
    
    try {
        // Process all tags in parallel
        await Promise.all(tags.map((tag, index) => processTag(tag, index)));
    } finally {
        // Always remove from processing set
        processingMessages.delete(messageId);
        iigLog('INFO', `Finished processing message ${messageId}`);
    }
    
    // Save chat to persist changes
    await context.saveChat();
    
    // Force re-render the message to show updated content
    // Use SillyTavern's messageFormatting if available
    if (typeof context.messageFormatting === 'function') {
        const formattedMessage = context.messageFormatting(
            message.mes,
            message.name,
            message.is_system,
            message.is_user,
            messageId
        );
        mesTextEl.innerHTML = formattedMessage;
        console.log('[IIG] Message re-rendered via messageFormatting');
    } else {
        // Fallback: trigger a manual re-render by finding and updating the element
        const freshMessageEl = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
        if (freshMessageEl && message.mes) {
            // Simple approach: just reload the message content
            // This works because message.mes now contains the image path instead of the tag
            console.log('[IIG] Attempting manual refresh...');
        }
    }
}

/**
 * Regenerate all images in a message (user-triggered)
 */
async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    
    if (!message) {
        toastr.error('Сообщение не найдено', 'Генерация картинок');
        return;
    }
    
    // Parse ALL instruction tags, forcing regeneration
    const tags = await parseImageTags(message.mes, { forceAll: true });
    
    if (tags.length === 0) {
        toastr.warning('Нет тегов для перегенерации', 'Генерация картинок');
        return;
    }
    
    iigLog('INFO', `Regenerating ${tags.length} images in message ${messageId}`);
    toastr.info(`Перегенерация ${tags.length} картинок...`, 'Генерация картинок');
    
    // Process using existing logic
    processingMessages.add(messageId);
    
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) {
        processingMessages.delete(messageId);
        return;
    }
    
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) {
        processingMessages.delete(messageId);
        return;
    }
    
    for (let index = 0; index < tags.length; index++) {
        const tag = tags[index];
        const tagId = `iig-regen-${messageId}-${index}`;
        
        try {
            // Find the existing img element with data-iig-instruction
            const existingImg = mesTextEl.querySelector(`img[data-iig-instruction]`);
            if (existingImg) {
                // Preserve the instruction for future regenerations
                const instruction = existingImg.getAttribute('data-iig-instruction');
                
                const loadingPlaceholder = createLoadingPlaceholder(tagId);
                existingImg.replaceWith(loadingPlaceholder);
                
                const statusEl = loadingPlaceholder.querySelector('.iig-status');
                
                const dataUrl = await generateImageWithRetry(
                    tag.prompt,
                    tag.style,
                    (status) => { statusEl.textContent = status; },
                    { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality }
                );
                
                statusEl.textContent = 'Сохранение...';
                const imagePath = await saveImageToFile(dataUrl);
                
                const img = document.createElement('img');
                img.className = 'iig-generated-image';
                img.src = imagePath;
                img.alt = tag.prompt;
                // Preserve instruction for future regenerations
                if (instruction) {
                    img.setAttribute('data-iig-instruction', instruction);
                }
                loadingPlaceholder.replaceWith(img);
                
                // Update message.mes
                const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
                message.mes = message.mes.replace(tag.fullMatch, updatedTag);
                
                toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
            }
        } catch (error) {
            iigLog('ERROR', `Regeneration failed for tag ${index}:`, error.message);
            toastr.error(`Ошибка: ${error.message}`, 'Генерация картинок');
        }
    }
    
    processingMessages.delete(messageId);
    await context.saveChat();
    iigLog('INFO', `Regeneration complete for message ${messageId}`);
}

/**
 * Add regenerate button to message extra menu (three dots)
 */
function addRegenerateButton(messageElement, messageId) {
    // Check if button already exists
    if (messageElement.querySelector('.iig-regenerate-btn')) return;
    
    // Find the extraMesButtons container (three dots menu)
    const extraMesButtons = messageElement.querySelector('.extraMesButtons');
    if (!extraMesButtons) return;
    
    const btn = document.createElement('div');
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = 'Перегенерировать картинки';
    btn.tabIndex = 0;
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await regenerateMessageImages(messageId);
    });
    
    extraMesButtons.appendChild(btn);
}

/**
 * Add regenerate buttons to all existing AI messages in chat
 */
function addButtonsToExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat || context.chat.length === 0) return;
    
    const messageElements = document.querySelectorAll('#chat .mes');
    let addedCount = 0;
    
    for (const messageElement of messageElements) {
        const mesId = messageElement.getAttribute('mesid');
        if (mesId === null) continue;
        
        const messageId = parseInt(mesId, 10);
        const message = context.chat[messageId];
        
        // Only add to AI messages (not user messages)
        if (message && !message.is_user) {
            addRegenerateButton(messageElement, messageId);
            addedCount++;
        }
    }
    
    iigLog('INFO', `Added regenerate buttons to ${addedCount} existing messages`);
}

// NOTE: No click handlers on error images - user uses the regenerate button in message menu

/**
 * Handle CHARACTER_MESSAGE_RENDERED event
 * This fires AFTER the message is rendered to DOM
 */
async function onMessageReceived(messageId) {
    iigLog('INFO', `onMessageReceived: ${messageId}`);
    
    const settings = getSettings();
    if (!settings.enabled) {
        iigLog('INFO', 'Extension disabled, skipping');
        return;
    }
    
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    
    // Always add regenerate button for AI messages
    addRegenerateButton(messageElement, messageId);
    
    await processMessageTags(messageId);
}

/**
 * Create settings UI
 */
function createSettingsUI() {
    const settings = getSettings();
    const context = SillyTavern.getContext();
    
    const container = document.getElementById('extensions_settings');
    if (!container) {
        console.error('[IIG] Settings container not found');
        return;
    }
    
    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Генерация картинок</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    <!-- Вкл/Выкл -->
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить генерацию картинок</span>
                    </label>
                    
                    <hr>
                    
                    <h4>Настройки API</h4>
                    
                    <!-- API Presets -->
                    <div class="flex-row">
                        <label for="iig_api_preset">Пресет API</label>
                        <select id="iig_api_preset" class="flex1">
                            <option value="">-- Без пресета --</option>
                            ${settings.apiPresets.map(p => `<option value="${p.name}" ${p.name === settings.activePreset ? 'selected' : ''}>${p.name}</option>`).join('')}
                        </select>
                        <div id="iig_save_preset" class="menu_button" title="Сохранить текущие настройки как пресет">
                            <i class="fa-solid fa-floppy-disk"></i>
                        </div>
                        <div id="iig_delete_preset" class="menu_button" title="Удалить выбранный пресет">
                            <i class="fa-solid fa-trash"></i>
                        </div>
                    </div>
                    <p class="hint">Сохраните несколько API конфигураций для быстрого переключения.</p>
                    
                    <!-- Тип эндпоинта -->
                    <div class="flex-row">
                        <label for="iig_api_type">Тип API</label>
                        <select id="iig_api_type" class="flex1">
                            <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-совместимый (/v1/images/generations)</option>
                            <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini-совместимый (nano-banana)</option>
                        </select>
                    </div>
                    
                    <!-- URL эндпоинта -->
                    <div class="flex-row">
                        <label for="iig_endpoint">URL эндпоинта</label>
                        <input type="text" id="iig_endpoint" class="text_pole flex1" 
                               value="${settings.endpoint}" 
                               placeholder="https://api.example.com">
                    </div>
                    
                    <!-- API ключ -->
                    <div class="flex-row">
                        <label for="iig_api_key">API ключ</label>
                        <input type="password" id="iig_api_key" class="text_pole flex1" 
                               value="${settings.apiKey}">
                        <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть">
                            <i class="fa-solid fa-eye"></i>
                        </div>
                    </div>
                    
                    <!-- Модель -->
                    <div class="flex-row">
                        <label for="iig_model">Модель</label>
                        <select id="iig_model" class="flex1">
                            ${settings.model ? `<option value="${settings.model}" selected>${settings.model}</option>` : '<option value="">-- Выберите модель --</option>'}
                        </select>
                        <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Обновить список">
                            <i class="fa-solid fa-sync"></i>
                        </div>
                    </div>
                    
                    <hr>
                    
                    <h4>Параметры генерации</h4>
                    
                    <!-- Размер -->
                    <div class="flex-row">
                        <label for="iig_size">Размер</label>
                        <select id="iig_size" class="flex1">
                            <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>1024x1024 (Квадрат)</option>
                            <option value="1792x1024" ${settings.size === '1792x1024' ? 'selected' : ''}>1792x1024 (Альбомная)</option>
                            <option value="1024x1792" ${settings.size === '1024x1792' ? 'selected' : ''}>1024x1792 (Портретная)</option>
                            <option value="512x512" ${settings.size === '512x512' ? 'selected' : ''}>512x512 (Маленький)</option>
                        </select>
                    </div>
                    
                    <!-- Качество -->
                    <div class="flex-row">
                        <label for="iig_quality">Качество</label>
                        <select id="iig_quality" class="flex1">
                            <option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>Стандартное</option>
                            <option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>HD</option>
                        </select>
                    </div>
                    
                    <hr>
                    
                    <h4>Стиль и референсы</h4>
                    
                    <!-- Default Style -->
                    <div class="flex-row">
                        <label for="iig_default_style">Стиль по умолчанию</label>
                        <textarea id="iig_default_style" class="text_pole flex1" rows="2" 
                                  placeholder="semi_realistic, manhwa style, soft lighting, detailed...">${settings.defaultStyle || ''}</textarea>
                    </div>
                    <p class="hint">Добавляется к каждому промпту. Сохраняет одежду, локацию, арт-стиль.</p>
                    
                    <!-- Style Reference Image -->
                    <div class="flex-row" style="align-items: flex-start;">
                        <label>Стиль-референс</label>
                        <div class="flex1" style="display:flex; flex-direction:column; gap:5px;">
                            <div style="display:flex; gap:5px; align-items:center;">
                                <input type="file" id="iig_style_ref_upload" accept="image/*" style="flex:1; font-size:0.85em;">
                                <div id="iig_style_ref_clear" class="menu_button" title="Убрать референс" ${!settings.styleReferenceImage ? 'style="display:none"' : ''}>
                                    <i class="fa-solid fa-xmark"></i>
                                </div>
                            </div>
                            <div id="iig_style_ref_preview" class="iig-avatar-preview" ${!settings.styleReferenceThumb ? 'style="display:none"' : ''}>
                                ${settings.styleReferenceThumb ? `<img src="data:image/jpeg;base64,${settings.styleReferenceThumb}" alt="style ref">` : ''}
                            </div>
                        </div>
                    </div>
                    <p class="hint">Загрузите картинку — её арт-стиль будет копироваться при генерации.</p>
                    
                    <h5>Референсы аватаров</h5>
                    <p class="hint">Отправлять аватарки для консистентности персонажей.</p>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_send_char_avatar" ${settings.sendCharAvatar ? 'checked' : ''}>
                        <span>Отправлять аватар {{char}}</span>
                    </label>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_send_user_avatar" ${settings.sendUserAvatar ? 'checked' : ''}>
                        <span>Отправлять аватар {{user}}</span>
                    </label>
                    
                    <!-- User Avatar Selection -->
                    <div id="iig_user_avatar_row" class="flex-row ${!settings.sendUserAvatar ? 'hidden' : ''}" style="margin-top: 5px;">
                        <label for="iig_user_avatar_file">Аватар {{user}}</label>
                        <select id="iig_user_avatar_file" class="flex1">
                            <option value="">-- Не выбран --</option>
                            ${settings.userAvatarFile ? `<option value="${settings.userAvatarFile}" selected>${settings.userAvatarFile}</option>` : ''}
                        </select>
                        <div id="iig_refresh_avatars" class="menu_button iig-refresh-btn" title="Обновить список">
                            <i class="fa-solid fa-sync"></i>
                        </div>
                    </div>
                    <div id="iig_user_avatar_preview" class="iig-avatar-preview ${!settings.userAvatarFile ? 'hidden' : ''}">
                        ${settings.userAvatarFile ? `<img src="/User Avatars/${encodeURIComponent(settings.userAvatarFile)}" alt="user avatar">` : ''}
                    </div>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_send_previous_image" ${settings.sendPreviousImage ? 'checked' : ''}>
                        <span>Отправлять предыдущую картинку</span>
                    </label>
                    <p class="hint">Последняя сгенерированная картинка из чата — для сохранения одежды, локации и т.д.</p>
                    
                    <hr>
                    
                    <!-- NPC References -->
                    <h5>НПС референсы</h5>
                    <p class="hint">Добавьте аватарки НПС для консистентности второстепенных персонажей.</p>
                    <div id="iig_npc_list" class="iig-npc-list">
                        ${(settings.npcReferences || []).map((npc, i) => `
                            <div class="iig-npc-entry" data-index="${i}">
                                <div class="flex-row" style="gap:5px;">
                                    <input type="text" class="text_pole iig-npc-name" value="${npc.name || ''}" placeholder="Имя НПС" style="width:120px;">
                                    <select class="iig-npc-source" style="width:100px;">
                                        <option value="characters" ${npc.source !== 'upload' ? 'selected' : ''}>Персонаж</option>
                                        <option value="upload" ${npc.source === 'upload' ? 'selected' : ''}>Файл</option>
                                    </select>
                                    <select class="iig-npc-char-file flex1 ${npc.source === 'upload' ? 'hidden' : ''}" style="min-width:0;">
                                        <option value="${npc.file || ''}" selected>${npc.file || '-- Выберите --'}</option>
                                    </select>
                                    <input type="file" class="iig-npc-file-upload ${npc.source !== 'upload' ? 'hidden' : ''}" accept="image/*" style="flex:1; font-size:0.8em;">
                                    <div class="menu_button iig-npc-remove" title="Удалить"><i class="fa-solid fa-xmark"></i></div>
                                </div>
                                <div class="iig-avatar-preview iig-npc-preview ${!npc.file && !npc.data ? 'hidden' : ''}">
                                    ${npc.source === 'upload' && npc.thumb ? `<img src="data:image/jpeg;base64,${npc.thumb}" alt="${npc.name}">` : 
                                      npc.file && npc.source !== 'upload' ? `<img src="/characters/${encodeURIComponent(npc.file)}" alt="${npc.name}">` : ''}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                    <div id="iig_add_npc" class="menu_button" style="width:100%; margin-top:5px;">
                        <i class="fa-solid fa-plus"></i> Добавить НПС
                    </div>
                    
                    <hr>
                    
                    <!-- Опции для Nano-Banana -->
                    <div id="iig_gemini_section" class="iig-gemini-section ${settings.apiType !== 'gemini' ? 'hidden' : ''}">
                        <h4>Настройки Nano-Banana</h4>
                        
                        <!-- Aspect Ratio -->
                        <div class="flex-row">
                            <label for="iig_aspect_ratio">Соотношение сторон</label>
                            <select id="iig_aspect_ratio" class="flex1">
                                <option value="1:1" ${settings.aspectRatio === '1:1' ? 'selected' : ''}>1:1 (Квадрат)</option>
                                <option value="2:3" ${settings.aspectRatio === '2:3' ? 'selected' : ''}>2:3 (Портрет)</option>
                                <option value="3:2" ${settings.aspectRatio === '3:2' ? 'selected' : ''}>3:2 (Альбом)</option>
                                <option value="3:4" ${settings.aspectRatio === '3:4' ? 'selected' : ''}>3:4 (Портрет)</option>
                                <option value="4:3" ${settings.aspectRatio === '4:3' ? 'selected' : ''}>4:3 (Альбом)</option>
                                <option value="4:5" ${settings.aspectRatio === '4:5' ? 'selected' : ''}>4:5 (Портрет)</option>
                                <option value="5:4" ${settings.aspectRatio === '5:4' ? 'selected' : ''}>5:4 (Альбом)</option>
                                <option value="9:16" ${settings.aspectRatio === '9:16' ? 'selected' : ''}>9:16 (Вертикальный)</option>
                                <option value="16:9" ${settings.aspectRatio === '16:9' ? 'selected' : ''}>16:9 (Широкий)</option>
                                <option value="21:9" ${settings.aspectRatio === '21:9' ? 'selected' : ''}>21:9 (Ультраширокий)</option>
                            </select>
                        </div>
                        
                        <!-- Image Size -->
                        <div class="flex-row">
                            <label for="iig_image_size">Разрешение</label>
                            <select id="iig_image_size" class="flex1">
                                <option value="1K" ${settings.imageSize === '1K' ? 'selected' : ''}>1K (по умолчанию)</option>
                                <option value="2K" ${settings.imageSize === '2K' ? 'selected' : ''}>2K</option>
                                <option value="4K" ${settings.imageSize === '4K' ? 'selected' : ''}>4K</option>
                            </select>
                        </div>
                        
                        <hr>
                    </div>
                    
                    <hr>
                    
                    <h4>Обработка ошибок</h4>
                    
                    <!-- Макс. повторов -->
                    <div class="flex-row">
                        <label for="iig_max_retries">Макс. повторов</label>
                        <input type="number" id="iig_max_retries" class="text_pole flex1" 
                               value="${settings.maxRetries}" min="0" max="5">
                    </div>
                    
                    <!-- Задержка -->
                    <div class="flex-row">
                        <label for="iig_retry_delay">Задержка (мс)</label>
                        <input type="number" id="iig_retry_delay" class="text_pole flex1" 
                               value="${settings.retryDelay}" min="500" max="10000" step="500">
                    </div>
                    
                    <hr>
                    
                    <h4>Отладка</h4>
                    
                    <div class="flex-row">
                        <div id="iig_export_logs" class="menu_button" style="width: 100%;">
                            <i class="fa-solid fa-download"></i> Экспорт логов
                        </div>
                    </div>
                    <p class="hint">Экспортировать логи расширения для отладки проблем.</p>
                </div>
            </div>
        </div>
    `;
    
    container.insertAdjacentHTML('beforeend', html);
    
    // Bind event handlers
    bindSettingsEvents();
}

/**
 * Rebuild NPC references list UI
 */
async function rebuildNpcList() {
    const settings = getSettings();
    const container = document.getElementById('iig_npc_list');
    if (!container) return;
    
    // Fetch characters for dropdown
    const characters = await fetchAllCharacters();
    
    container.innerHTML = '';
    
    for (let i = 0; i < settings.npcReferences.length; i++) {
        const npc = settings.npcReferences[i];
        const isUpload = npc.source === 'upload';
        
        const charOptions = characters.map(c => 
            `<option value="${c.avatar}" ${c.avatar === npc.file && !isUpload ? 'selected' : ''}>${c.name}</option>`
        ).join('');
        
        const entry = document.createElement('div');
        entry.className = 'iig-npc-entry';
        entry.dataset.index = i;
        entry.innerHTML = `
            <div class="flex-row" style="gap:5px;">
                <input type="text" class="text_pole iig-npc-name" value="${npc.name || ''}" placeholder="Имя НПС" style="width:120px;">
                <select class="iig-npc-source" style="width:100px;">
                    <option value="characters" ${!isUpload ? 'selected' : ''}>Персонаж</option>
                    <option value="upload" ${isUpload ? 'selected' : ''}>Файл</option>
                </select>
                <select class="iig-npc-char-file flex1 ${isUpload ? 'hidden' : ''}" style="min-width:0;">
                    <option value="">-- Выберите --</option>
                    ${charOptions}
                </select>
                <input type="file" class="iig-npc-file-upload ${!isUpload ? 'hidden' : ''}" accept="image/*" style="flex:1; font-size:0.8em;">
                <div class="menu_button iig-npc-remove" title="Удалить"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div class="iig-avatar-preview iig-npc-preview ${!npc.file && !npc.data ? 'hidden' : ''}">
                ${isUpload && npc.thumb ? `<img src="data:image/jpeg;base64,${npc.thumb}" alt="${npc.name}">` :
                  npc.file && !isUpload ? `<img src="/characters/${encodeURIComponent(npc.file)}" alt="${npc.name}">` : ''}
            </div>
        `;
        container.appendChild(entry);
    }
}

/**
 * Bind settings event handlers
 */
function bindSettingsEvents() {
    const settings = getSettings();
    
    // Enable toggle
    document.getElementById('iig_enabled')?.addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
    });
    
    // API Type
    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        settings.apiType = e.target.value;
        saveSettings();
        
        // Show/hide Gemini-specific section
        const geminiSection = document.getElementById('iig_gemini_section');
        if (geminiSection) {
            geminiSection.classList.toggle('hidden', e.target.value !== 'gemini');
        }
    });
    
    // Default Style
    document.getElementById('iig_default_style')?.addEventListener('input', (e) => {
        settings.defaultStyle = e.target.value;
        saveSettings();
    });
    
    // Endpoint
    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => {
        settings.endpoint = e.target.value;
        saveSettings();
    });
    
    // API Key
    document.getElementById('iig_api_key')?.addEventListener('input', (e) => {
        settings.apiKey = e.target.value;
        saveSettings();
    });
    
    // API Key toggle visibility
    document.getElementById('iig_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_api_key');
        const icon = document.querySelector('#iig_key_toggle i');
        if (input.type === 'password') {
            input.type = 'text';
            icon.classList.replace('fa-eye', 'fa-eye-slash');
        } else {
            input.type = 'password';
            icon.classList.replace('fa-eye-slash', 'fa-eye');
        }
    });
    
    // Model
    document.getElementById('iig_model')?.addEventListener('change', (e) => {
        settings.model = e.target.value;
        saveSettings();
        
        // Auto-switch API type based on model
        if (isGeminiModel(e.target.value)) {
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
            document.getElementById('iig_gemini_section')?.classList.remove('hidden');
        }
    });
    
    // Refresh models
    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');
        
        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');
            
            // Keep current selection if it exists in new list
            const currentModel = settings.model;
            
            select.innerHTML = '<option value="">-- Выберите модель --</option>';
            
            for (const model of models) {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                option.selected = model === currentModel;
                select.appendChild(option);
            }
            
            toastr.success(`Найдено моделей: ${models.length}`, 'Генерация картинок');
        } catch (error) {
            toastr.error('Ошибка загрузки моделей', 'Генерация картинок');
        } finally {
            btn.classList.remove('loading');
        }
    });
    
    // Size
    document.getElementById('iig_size')?.addEventListener('change', (e) => {
        settings.size = e.target.value;
        saveSettings();
    });
    
    // Quality
    document.getElementById('iig_quality')?.addEventListener('change', (e) => {
        settings.quality = e.target.value;
        saveSettings();
    });
    
    // Aspect Ratio (nano-banana)
    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => {
        settings.aspectRatio = e.target.value;
        saveSettings();
    });
    
    // Image Size (nano-banana)
    document.getElementById('iig_image_size')?.addEventListener('change', (e) => {
        settings.imageSize = e.target.value;
        saveSettings();
    });
    
    // Send char avatar
    document.getElementById('iig_send_char_avatar')?.addEventListener('change', (e) => {
        settings.sendCharAvatar = e.target.checked;
        saveSettings();
    });
    
    // Send user avatar
    document.getElementById('iig_send_user_avatar')?.addEventListener('change', (e) => {
        settings.sendUserAvatar = e.target.checked;
        saveSettings();
        
        // Show/hide avatar selection row
        const avatarRow = document.getElementById('iig_user_avatar_row');
        if (avatarRow) {
            avatarRow.classList.toggle('hidden', !e.target.checked);
        }
    });
    
    // User avatar file selection - with preview
    document.getElementById('iig_user_avatar_file')?.addEventListener('change', (e) => {
        settings.userAvatarFile = e.target.value;
        saveSettings();
        
        const preview = document.getElementById('iig_user_avatar_preview');
        if (preview) {
            if (e.target.value) {
                preview.innerHTML = `<img src="/User Avatars/${encodeURIComponent(e.target.value)}" alt="user avatar">`;
                preview.classList.remove('hidden');
            } else {
                preview.innerHTML = '';
                preview.classList.add('hidden');
            }
        }
    });
    
    // Send previous image
    document.getElementById('iig_send_previous_image')?.addEventListener('change', (e) => {
        settings.sendPreviousImage = e.target.checked;
        saveSettings();
    });
    
    // Refresh user avatars list
    document.getElementById('iig_refresh_avatars')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');
        
        try {
            const avatars = await fetchUserAvatars();
            const select = document.getElementById('iig_user_avatar_file');
            const currentAvatar = settings.userAvatarFile;
            
            select.innerHTML = '<option value="">-- Не выбран --</option>';
            
            for (const avatar of avatars) {
                const option = document.createElement('option');
                option.value = avatar;
                option.textContent = avatar;
                option.selected = avatar === currentAvatar;
                select.appendChild(option);
            }
            
            toastr.success(`Найдено аватаров: ${avatars.length}`, 'Генерация картинок');
        } catch (error) {
            toastr.error('Ошибка загрузки аватаров', 'Генерация картинок');
        } finally {
            btn.classList.remove('loading');
        }
    });
    
    // === API PRESETS ===
    document.getElementById('iig_api_preset')?.addEventListener('change', (e) => {
        if (e.target.value) {
            loadApiPreset(e.target.value);
        } else {
            settings.activePreset = '';
            saveSettings();
        }
    });
    
    document.getElementById('iig_save_preset')?.addEventListener('click', () => {
        const name = prompt('Имя пресета:', settings.activePreset || '');
        if (name && name.trim()) {
            saveApiPreset(name.trim());
            refreshPresetDropdown();
        }
    });
    
    document.getElementById('iig_delete_preset')?.addEventListener('click', () => {
        const select = document.getElementById('iig_api_preset');
        const name = select?.value;
        if (!name) {
            toastr.warning('Выберите пресет для удаления', 'Генерация картинок');
            return;
        }
        if (confirm(`Удалить пресет "${name}"?`)) {
            deleteApiPreset(name);
            refreshPresetDropdown();
        }
    });
    
    // === STYLE REFERENCE IMAGE ===
    document.getElementById('iig_style_ref_upload')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        
        try {
            const base64 = await fileToBase64(file);
            const thumb = await createThumbnail(base64, 100);
            
            settings.styleReferenceImage = base64;
            settings.styleReferenceThumb = thumb;
            saveSettings();
            
            const preview = document.getElementById('iig_style_ref_preview');
            if (preview) {
                preview.innerHTML = `<img src="data:image/jpeg;base64,${thumb}" alt="style ref">`;
                preview.style.display = '';
            }
            document.getElementById('iig_style_ref_clear').style.display = '';
            
            toastr.success('Стиль-референс загружен', 'Генерация картинок');
        } catch (err) {
            toastr.error('Ошибка загрузки: ' + err.message, 'Генерация картинок');
        }
    });
    
    document.getElementById('iig_style_ref_clear')?.addEventListener('click', () => {
        settings.styleReferenceImage = '';
        settings.styleReferenceThumb = '';
        saveSettings();
        
        const preview = document.getElementById('iig_style_ref_preview');
        if (preview) { preview.innerHTML = ''; preview.style.display = 'none'; }
        const upload = document.getElementById('iig_style_ref_upload');
        if (upload) upload.value = '';
        document.getElementById('iig_style_ref_clear').style.display = 'none';
        
        toastr.success('Стиль-референс удалён', 'Генерация картинок');
    });
    
    // === NPC REFERENCES ===
    document.getElementById('iig_add_npc')?.addEventListener('click', () => {
        settings.npcReferences.push({ name: '', file: '', source: 'characters', data: '', thumb: '' });
        saveSettings();
        rebuildNpcList();
    });
    
    document.getElementById('iig_npc_list')?.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.iig-npc-remove');
        if (removeBtn) {
            const entry = removeBtn.closest('.iig-npc-entry');
            const idx = parseInt(entry?.dataset.index);
            if (!isNaN(idx)) {
                settings.npcReferences.splice(idx, 1);
                saveSettings();
                rebuildNpcList();
            }
        }
    });
    
    document.getElementById('iig_npc_list')?.addEventListener('change', async (e) => {
        const entry = e.target.closest('.iig-npc-entry');
        if (!entry) return;
        const idx = parseInt(entry.dataset.index);
        if (isNaN(idx) || !settings.npcReferences[idx]) return;
        
        const npc = settings.npcReferences[idx];
        
        if (e.target.classList.contains('iig-npc-source')) {
            npc.source = e.target.value;
            npc.file = '';
            npc.data = '';
            npc.thumb = '';
            saveSettings();
            rebuildNpcList();
        }
        
        if (e.target.classList.contains('iig-npc-char-file')) {
            npc.file = e.target.value;
            npc.source = 'characters';
            saveSettings();
            const preview = entry.querySelector('.iig-npc-preview');
            if (preview && e.target.value) {
                preview.innerHTML = `<img src="/characters/${encodeURIComponent(e.target.value)}" alt="${npc.name}">`;
                preview.classList.remove('hidden');
            }
        }
        
        if (e.target.classList.contains('iig-npc-file-upload')) {
            const file = e.target.files?.[0];
            if (file) {
                try {
                    const base64 = await fileToBase64(file);
                    const thumb = await createThumbnail(base64, 80);
                    npc.data = base64;
                    npc.file = file.name;
                    npc.source = 'upload';
                    npc.thumb = thumb;
                    saveSettings();
                    const preview = entry.querySelector('.iig-npc-preview');
                    if (preview) {
                        preview.innerHTML = `<img src="data:image/jpeg;base64,${thumb}" alt="${npc.name}">`;
                        preview.classList.remove('hidden');
                    }
                } catch (err) {
                    toastr.error('Ошибка: ' + err.message, 'Генерация картинок');
                }
            }
        }
    });
    
    document.getElementById('iig_npc_list')?.addEventListener('input', (e) => {
        if (e.target.classList.contains('iig-npc-name')) {
            const entry = e.target.closest('.iig-npc-entry');
            const idx = parseInt(entry?.dataset.index);
            if (!isNaN(idx) && settings.npcReferences[idx]) {
                settings.npcReferences[idx].name = e.target.value;
                saveSettings();
            }
        }
    });
    
    // Max retries
    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => {
        settings.maxRetries = parseInt(e.target.value) || 3;
        saveSettings();
    });
    
    // Retry delay
    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => {
        settings.retryDelay = parseInt(e.target.value) || 1000;
        saveSettings();
    });
    
    // Export logs
    document.getElementById('iig_export_logs')?.addEventListener('click', () => {
        exportLogs();
    });
}

/**
 * Initialize extension
 */
(function init() {
    const context = SillyTavern.getContext();
    
    // Debug: log available event types
    console.log('[IIG] Available event_types:', context.event_types);
    console.log('[IIG] CHARACTER_MESSAGE_RENDERED:', context.event_types.CHARACTER_MESSAGE_RENDERED);
    console.log('[IIG] MESSAGE_SWIPED:', context.event_types.MESSAGE_SWIPED);
    
    // Load settings
    getSettings();
    
    // Create settings UI when app is ready
    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        // Add buttons to any messages already in chat
        addButtonsToExistingMessages();
        console.log('[IIG] Inline Image Generation extension loaded');
    });
    
    // When chat is loaded/changed, add buttons to all existing messages
    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        iigLog('INFO', 'CHAT_CHANGED event - adding buttons to existing messages');
        // Small delay to ensure DOM is ready
        setTimeout(() => {
            addButtonsToExistingMessages();
        }, 100);
    });
    
    // Wrapper to add debug logging
    const handleMessage = async (messageId) => {
        console.log('[IIG] Event triggered for message:', messageId);
        await onMessageReceived(messageId);
    };
    
    // Listen for new messages AFTER they're rendered in DOM
    // CHARACTER_MESSAGE_RENDERED fires after addOneMessage() completes
    // This is the ONLY event we handle - no auto-retry on swipe/update
    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, handleMessage);
    
    // NOTE: We intentionally DO NOT handle MESSAGE_SWIPED or MESSAGE_UPDATED
    // Swipe = user wants NEW content, not to retry old error images
    // If user wants to retry failed images, they use the regenerate button in menu
    
    console.log('[IIG] Inline Image Generation extension initialized');
})();
