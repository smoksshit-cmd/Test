/**
 * Inline Image Generation Extension for SillyTavern
 * 
 * Catches [IMG:GEN:{json}] tags in AI messages and generates images via configured API.
 * Supports OpenAI-compatible and Gemini-compatible (nano-banana) endpoints.
 * 
 * NEW: NPC Manager, Vision-based appearance analysis, Reference images for char/user/NPCs
 */

const MODULE_NAME = 'inline_image_gen';

// Track messages currently being processed to prevent duplicate processing
const processingMessages = new Set();

// Cache for vision-analyzed appearances (avatarUrl -> description text)
const appearanceCache = new Map();

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
    apiType: 'openai',
    endpoint: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    quality: 'standard',
    maxRetries: 0,
    retryDelay: 1000,
    // Nano-banana specific
    sendCharAvatar: false,
    sendUserAvatar: false,
    userAvatarFile: '',
    aspectRatio: '1:1',
    imageSize: '1K',
    // Custom prompts
    positivePrompt: '',
    negativePrompt: '',
    // Fixed style
    fixedStyle: '',
    fixedStyleEnabled: false,
    // Appearance extraction
    extractAppearance: true,
    extractUserAppearance: true,
    // Clothing detection
    detectClothing: true,
    clothingSearchDepth: 5,
    // === NEW: Vision analysis ===
    visionEnabled: false,          // Use Vision API to analyze avatars
    visionEndpoint: '',            // Vision API endpoint (can be same as main)
    visionApiKey: '',              // Vision API key
    visionModel: 'gpt-4o-mini',   // Vision model to use
    visionCacheEnabled: true,      // Cache analyzed appearances
    // === NEW: NPC Manager ===
    npcs: [],                      // Array of NPC objects: {id, name, enabled, avatarFile, avatarPath, description}
    npcDetectInChat: true,         // Auto-detect NPC mentions in chat
    npcSendAsReference: true,      // Send NPC avatar as reference image
    npcAnalyzeAppearance: true,    // Analyze NPC avatar with Vision
    npcChatSearchDepth: 10,        // How many messages back to search for NPC mentions
});

// Image model detection keywords
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

/**
 * Check if model ID is an image generation model
 */
function isImageModel(modelId) {
    const mid = modelId.toLowerCase();
    for (const kw of VIDEO_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return false;
    }
    if (mid.includes('vision') && mid.includes('preview')) return false;
    for (const kw of IMAGE_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return true;
    }
    return false;
}

/**
 * Check if model is Gemini/nano-banana type
 */
function isGeminiModel(modelId) {
    return modelId.toLowerCase().includes('nano-banana');
}

/**
 * Get extension settings
 */
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
    return context.extensionSettings[MODULE_NAME];
}

/**
 * Save settings
 */
function saveSettings() {
    const context = SillyTavern.getContext();
    context.saveSettingsDebounced();
    const settings = context.extensionSettings[MODULE_NAME];
    iigLog('INFO', `Settings saved. fixedStyle="${settings?.fixedStyle || ''}", npcs=${settings?.npcs?.length || 0}`);
}

// ============================================================
// VISION API - Analyze avatar images to extract appearance
// ============================================================

/**
 * Analyze an image via Vision API and return appearance description
 * @param {string} base64Image - Base64 image data (no prefix)
 * @param {string} personName - Name of the person/character
 * @param {string} cacheKey - Cache key for this image
 * @returns {Promise<string|null>} - Appearance description text
 */
async function analyzeAvatarWithVision(base64Image, personName, cacheKey) {
    const settings = getSettings();
    
    if (!settings.visionEnabled) return null;
    
    // Check cache
    if (settings.visionCacheEnabled && cacheKey && appearanceCache.has(cacheKey)) {
        iigLog('INFO', `Vision cache hit for: ${cacheKey}`);
        return appearanceCache.get(cacheKey);
    }
    
    const endpoint = (settings.visionEndpoint || settings.endpoint).replace(/\/$/, '');
    const apiKey = settings.visionApiKey || settings.apiKey;
    const model = settings.visionModel || 'gpt-4o-mini';
    
    if (!endpoint || !apiKey) {
        iigLog('WARN', 'Vision API not configured, skipping analysis');
        return null;
    }
    
    try {
        iigLog('INFO', `Analyzing avatar for "${personName}" via Vision API (model: ${model})`);
        
        const prompt = `Analyze this character/person image and describe their physical appearance in detail for use in an image generation prompt.

Focus on:
- Hair: color, length, style, texture
- Eyes: color, shape, distinctive features
- Skin: tone, texture, any markings
- Face: shape, notable features (freckles, scars, etc.)
- Body: build, height impression, posture
- Distinctive features: ears shape (pointed/round/animal), tails, horns, wings, markings, etc.
- Age appearance

Format your response as a concise comma-separated list of descriptors suitable for an image generation prompt.
Example: "silver long hair, violet eyes, pale skin, petite build, pointed elf ears, slender figure"

DO NOT describe clothing. Only physical appearance.
Keep it under 150 words.`;
        
        const response = await fetch(`${endpoint}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: model,
                max_tokens: 300,
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:image/png;base64,${base64Image}`,
                                detail: 'low'
                            }
                        },
                        {
                            type: 'text',
                            text: prompt
                        }
                    ]
                }]
            })
        });
        
        if (!response.ok) {
            const err = await response.text();
            iigLog('ERROR', `Vision API error: ${response.status} - ${err.substring(0, 200)}`);
            return null;
        }
        
        const data = await response.json();
        const description = data.choices?.[0]?.message?.content?.trim();
        
        if (!description) {
            iigLog('WARN', 'Vision API returned empty description');
            return null;
        }
        
        iigLog('INFO', `Vision analysis for "${personName}": ${description.substring(0, 100)}`);
        
        // Cache result
        if (settings.visionCacheEnabled && cacheKey) {
            appearanceCache.set(cacheKey, description);
        }
        
        return description;
    } catch (error) {
        iigLog('ERROR', `Vision analysis failed for "${personName}":`, error.message);
        return null;
    }
}

// ============================================================
// AVATAR HELPERS
// ============================================================

/**
 * Convert image URL to base64
 */
async function imageUrlToBase64(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        iigLog('ERROR', `Failed to convert image to base64 (${url}):`, error.message);
        return null;
    }
}

/**
 * Save base64 image to file via SillyTavern API
 */
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
    iigLog('INFO', `Image saved to: ${result.path}`);
    return result.path;
}

/**
 * Get character avatar as base64
 */
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
        iigLog('ERROR', 'Error getting character avatar:', error.message);
        return null;
    }
}

/**
 * Get user avatar as base64
 */
async function getUserAvatarBase64() {
    try {
        const settings = getSettings();
        if (!settings.userAvatarFile) return null;
        return await imageUrlToBase64(`/User Avatars/${encodeURIComponent(settings.userAvatarFile)}`);
    } catch (error) {
        iigLog('ERROR', 'Error getting user avatar:', error.message);
        return null;
    }
}

/**
 * Get NPC avatar as base64 by trying multiple paths
 * Tries: /characters/NAME.png, /characters/NAME.jpg, /User Avatars/NAME.png, etc.
 */
async function getNpcAvatarBase64(npc) {
    // If explicit path is stored, try it first
    if (npc.avatarPath) {
        const b64 = await imageUrlToBase64(npc.avatarPath);
        if (b64) return { base64: b64, path: npc.avatarPath };
    }
    
    // Try standard character paths
    const nameCandidates = [
        npc.name,
        npc.name.toLowerCase(),
        npc.name.charAt(0).toUpperCase() + npc.name.slice(1).toLowerCase()
    ];
    const extensions = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
    const basePaths = ['/characters/', '/User Avatars/'];
    
    for (const base of basePaths) {
        for (const name of nameCandidates) {
            for (const ext of extensions) {
                const url = `${base}${encodeURIComponent(name)}.${ext}`;
                const b64 = await imageUrlToBase64(url);
                if (b64) {
                    iigLog('INFO', `Found NPC avatar at: ${url}`);
                    return { base64: b64, path: url };
                }
            }
        }
    }
    
    // Try from ST characters list by matching name
    try {
        const context = SillyTavern.getContext();
        const matchingChar = context.characters?.find(c => 
            c.name?.toLowerCase() === npc.name.toLowerCase()
        );
        if (matchingChar?.avatar) {
            const url = `/characters/${encodeURIComponent(matchingChar.avatar)}`;
            const b64 = await imageUrlToBase64(url);
            if (b64) {
                iigLog('INFO', `Found NPC avatar from ST characters list: ${url}`);
                return { base64: b64, path: url };
            }
        }
    } catch (e) {
        iigLog('WARN', `Error searching ST characters for NPC "${npc.name}":`, e.message);
    }
    
    iigLog('WARN', `Could not find avatar for NPC: ${npc.name}`);
    return null;
}

// ============================================================
// NPC DETECTION
// ============================================================

/**
 * Detect which NPCs are mentioned in recent chat messages
 * Returns array of enabled NPC objects that appear in chat
 */
function detectMentionedNpcs(depth = 10) {
    const settings = getSettings();
    const context = SillyTavern.getContext();
    
    if (!settings.npcs || settings.npcs.length === 0) return [];
    
    const enabledNpcs = settings.npcs.filter(n => n.enabled && n.name);
    if (enabledNpcs.length === 0) return [];
    
    const chat = context.chat;
    if (!chat || chat.length === 0) return [];
    
    const startIndex = Math.max(0, chat.length - depth);
    const recentText = chat.slice(startIndex).map(m => m.mes || '').join('\n').toLowerCase();
    
    const mentioned = [];
    for (const npc of enabledNpcs) {
        const nameLower = npc.name.toLowerCase();
        if (recentText.includes(nameLower)) {
            mentioned.push(npc);
            iigLog('INFO', `NPC "${npc.name}" detected in recent chat`);
        }
    }
    
    return mentioned;
}

// ============================================================
// APPEARANCE EXTRACTION (text-based from cards)
// ============================================================

const APPEARANCE_PATTERNS = [
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

const APPEARANCE_BLOCK_PATTERNS = [
    /\[?(?:appearance|внешность|looks?)\]?[:\s]*([^[\]]{10,500})/gi,
    /\[?(?:physical\s*description|физическое?\s*описание)\]?[:\s]*([^[\]]{10,500})/gi,
];

function extractAppearanceFromText(text, personName) {
    if (!text) return null;
    
    const foundTraits = [];
    const seenTexts = new Set();
    
    for (const pattern of APPEARANCE_PATTERNS) {
        pattern.lastIndex = 0;
        const matches = text.matchAll(pattern);
        for (const match of matches) {
            const trait = (match[1] || match[0]).trim();
            if (trait.length > 2 && !seenTexts.has(trait.toLowerCase())) {
                seenTexts.add(trait.toLowerCase());
                foundTraits.push(trait);
            }
        }
    }
    
    for (const pattern of APPEARANCE_BLOCK_PATTERNS) {
        pattern.lastIndex = 0;
        const matches = text.matchAll(pattern);
        for (const match of matches) {
            const block = match[1].trim();
            if (block.length > 10 && !seenTexts.has(block.toLowerCase())) {
                seenTexts.add(block.toLowerCase());
                foundTraits.push(block);
            }
        }
    }
    
    if (foundTraits.length === 0) return null;
    return `${personName}'s appearance: ${foundTraits.join(', ')}`;
}

function extractCharacterAppearance() {
    try {
        const context = SillyTavern.getContext();
        if (context.characterId === undefined || context.characterId === null) return null;
        const character = context.characters?.[context.characterId];
        if (!character?.description) return null;
        return extractAppearanceFromText(character.description, character.name || 'Character');
    } catch (error) {
        iigLog('ERROR', 'Error extracting character appearance:', error.message);
        return null;
    }
}

function extractUserAppearance() {
    try {
        const context = SillyTavern.getContext();
        const userName = context.name1 || 'User';
        let personaDescription = null;
        if (typeof window.power_user !== 'undefined' && window.power_user.persona_description) {
            personaDescription = window.power_user.persona_description;
        }
        if (!personaDescription) return null;
        
        const result = extractAppearanceFromText(personaDescription, userName);
        if (!result && personaDescription.length < 500) {
            return `${userName}'s appearance: ${personaDescription}`;
        }
        return result;
    } catch (error) {
        iigLog('ERROR', 'Error extracting user appearance:', error.message);
        return null;
    }
}

/**
 * Extract NPC appearance from their description field in settings
 */
function extractNpcAppearance(npc) {
    if (!npc.description) return null;
    return extractAppearanceFromText(npc.description, npc.name);
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
        const seenTexts = new Set();
        const startIndex = Math.max(0, chat.length - depth);
        
        for (let i = chat.length - 1; i >= startIndex; i--) {
            const message = chat[i];
            if (!message.mes) continue;
            const speaker = message.is_user ? userName : charName;
            
            for (const pattern of clothingPatterns) {
                pattern.lastIndex = 0;
                const matches = message.mes.matchAll(pattern);
                for (const match of matches) {
                    const clothing = (match[1] || match[0]).trim();
                    if (clothing.length > 3 && !seenTexts.has(clothing.toLowerCase())) {
                        seenTexts.add(clothing.toLowerCase());
                        foundClothing.push({ text: clothing, speaker, messageIndex: i });
                    }
                }
            }
        }
        
        if (foundClothing.length === 0) return null;
        
        const context2 = SillyTavern.getContext();
        const charName2 = context2.characters?.[context2.characterId]?.name || 'Character';
        const userName2 = context2.name1 || 'User';
        
        const charClothing = foundClothing.filter(c => c.speaker === charName2).map(c => c.text);
        const userClothing = foundClothing.filter(c => c.speaker === userName2).map(c => c.text);
        
        let clothingText = '';
        if (charClothing.length > 0) clothingText += `${charName2} is wearing: ${charClothing.slice(0, 3).join(', ')}. `;
        if (userClothing.length > 0) clothingText += `${userName2} is wearing: ${userClothing.slice(0, 3).join(', ')}.`;
        
        return clothingText.trim() || null;
    } catch (error) {
        iigLog('ERROR', 'Error detecting clothing:', error.message);
        return null;
    }
}

// ============================================================
// REFERENCE IMAGE & APPEARANCE COLLECTION
// ============================================================

/**
 * Collect all reference images and appearance descriptions for generation.
 * Returns { referenceImages: string[], appearanceParts: string[] }
 * 
 * Order of references: char avatar → user avatar → NPC avatars
 * Each can contribute both a reference image AND a vision-analyzed description.
 */
async function collectReferencesAndAppearances() {
    const settings = getSettings();
    const context = SillyTavern.getContext();
    const isGemini = settings.apiType === 'gemini' || isGeminiModel(settings.model);
    
    const referenceImages = [];
    const appearanceParts = [];
    
    // ── CHARACTER ──────────────────────────────────────────
    const charName = context.characters?.[context.characterId]?.name || 'Character';
    
    // Text-based appearance from card
    if (settings.extractAppearance) {
        const textAppearance = extractCharacterAppearance();
        if (textAppearance) {
            appearanceParts.push(`[Character "${charName}": ${textAppearance}]`);
            iigLog('INFO', `✓ Char text appearance extracted`);
        }
    }
    
    // Avatar (reference + vision analysis)
    if (settings.sendCharAvatar) {
        const charB64 = await getCharacterAvatarBase64();
        if (charB64) {
            // Reference image
            if (isGemini) referenceImages.push(charB64);
            
            // Vision analysis
            if (settings.visionEnabled) {
                const charAvatarKey = `char_${context.characterId}`;
                const visionDesc = await analyzeAvatarWithVision(charB64, charName, charAvatarKey);
                if (visionDesc) {
                    appearanceParts.push(`[Character "${charName}" visual appearance: ${visionDesc}]`);
                    iigLog('INFO', `✓ Char vision appearance analyzed`);
                }
            }
        }
    }
    
    // ── USER ───────────────────────────────────────────────
    const userName = context.name1 || 'User';
    
    // Text-based appearance from persona
    if (settings.extractUserAppearance !== false) {
        const textAppearance = extractUserAppearance();
        if (textAppearance) {
            appearanceParts.push(`[User "${userName}": ${textAppearance}]`);
            iigLog('INFO', `✓ User text appearance extracted`);
        }
    }
    
    // Avatar (reference + vision analysis)
    if (settings.sendUserAvatar) {
        const userB64 = await getUserAvatarBase64();
        if (userB64) {
            if (isGemini) referenceImages.push(userB64);
            
            if (settings.visionEnabled) {
                const userAvatarKey = `user_${settings.userAvatarFile}`;
                const visionDesc = await analyzeAvatarWithVision(userB64, userName, userAvatarKey);
                if (visionDesc) {
                    appearanceParts.push(`[User "${userName}" visual appearance: ${visionDesc}]`);
                    iigLog('INFO', `✓ User vision appearance analyzed`);
                }
            }
        }
    }
    
    // ── NPCs ───────────────────────────────────────────────
    if (settings.npcDetectInChat && settings.npcs && settings.npcs.length > 0) {
        const mentionedNpcs = detectMentionedNpcs(settings.npcChatSearchDepth || 10);
        
        for (const npc of mentionedNpcs) {
            iigLog('INFO', `Processing NPC: ${npc.name}`);
            
            // Text appearance from NPC description
            const textAppearance = extractNpcAppearance(npc);
            if (textAppearance) {
                appearanceParts.push(`[NPC "${npc.name}": ${textAppearance}]`);
            }
            
            // Avatar
            const avatarResult = await getNpcAvatarBase64(npc);
            if (avatarResult) {
                // Reference image
                if (isGemini && settings.npcSendAsReference) {
                    referenceImages.push(avatarResult.base64);
                }
                
                // Vision analysis
                if (settings.visionEnabled && settings.npcAnalyzeAppearance) {
                    const npcKey = `npc_${npc.id || npc.name}`;
                    const visionDesc = await analyzeAvatarWithVision(avatarResult.base64, npc.name, npcKey);
                    if (visionDesc) {
                        appearanceParts.push(`[NPC "${npc.name}" visual appearance: ${visionDesc}]`);
                        iigLog('INFO', `✓ NPC "${npc.name}" vision appearance analyzed`);
                    }
                }
            }
        }
    }
    
    iigLog('INFO', `References collected: ${referenceImages.length} images, ${appearanceParts.length} appearance parts`);
    return { referenceImages, appearanceParts };
}

// ============================================================
// PROMPT BUILDING
// ============================================================

/**
 * Build enhanced prompt with all context
 */
function buildEnhancedPrompt(basePrompt, style, appearanceParts = [], options = {}) {
    const context = SillyTavern.getContext();
    const settings = context.extensionSettings[MODULE_NAME] || {};
    
    iigLog('INFO', `buildEnhancedPrompt: fixedStyleEnabled=${settings.fixedStyleEnabled}, npcs=${appearanceParts.length} appearance parts`);
    
    const promptParts = [];
    
    // 1. Fixed style (highest priority)
    if (settings.fixedStyleEnabled === true && settings.fixedStyle?.trim()) {
        promptParts.push(`[STYLE: ${settings.fixedStyle.trim()}]`);
        iigLog('INFO', `✓ Applied fixed style: ${settings.fixedStyle}`);
    }
    
    // 2. Positive prompt from settings
    if (settings.positivePrompt?.trim()) {
        promptParts.push(settings.positivePrompt.trim());
    }
    
    // 3. Style from tag (if no fixed style)
    if (style && !(settings.fixedStyleEnabled === true && settings.fixedStyle?.trim())) {
        promptParts.push(`[Style: ${style}]`);
    }
    
    // 4. All appearance parts (char, user, NPCs - both text and vision-analyzed)
    for (const part of appearanceParts) {
        promptParts.push(part);
    }
    
    // 5. Clothing from chat
    if (settings.detectClothing === true) {
        const clothing = detectClothingFromChat(settings.clothingSearchDepth || 5);
        if (clothing) {
            promptParts.push(`[Current Clothing: ${clothing}]`);
        }
    }
    
    // 6. Main prompt
    promptParts.push(basePrompt);
    
    // 7. Negative prompt
    if (settings.negativePrompt?.trim()) {
        promptParts.push(`[AVOID: ${settings.negativePrompt.trim()}]`);
    }
    
    const fullPrompt = promptParts.join('\n\n');
    iigLog('INFO', `Built prompt: ${fullPrompt.length} chars, ${promptParts.length} parts`);
    return fullPrompt;
}

// ============================================================
// IMAGE GENERATION APIs
// ============================================================

const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];

async function generateImageOpenAI(prompt, style, referenceImages = [], appearanceParts = [], options = {}) {
    const settings = getSettings();
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/images/generations`;
    
    const fullPrompt = buildEnhancedPrompt(prompt, style, appearanceParts, options);
    
    let size = settings.size;
    if (options.aspectRatio === '16:9') size = '1792x1024';
    else if (options.aspectRatio === '9:16') size = '1024x1792';
    else if (options.aspectRatio === '1:1') size = '1024x1024';
    
    const body = {
        model: settings.model,
        prompt: fullPrompt,
        n: 1,
        size,
        quality: options.quality || settings.quality,
        response_format: 'b64_json'
    };
    
    if (referenceImages.length > 0) {
        body.image = `data:image/png;base64,${referenceImages[0]}`;
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

async function generateImageGemini(prompt, style, referenceImages = [], appearanceParts = [], options = {}) {
    const settings = getSettings();
    const model = settings.model;
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;
    
    let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) aspectRatio = VALID_ASPECT_RATIOS.includes(settings.aspectRatio) ? settings.aspectRatio : '1:1';
    
    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) imageSize = '1K';
    
    const parts = [];
    
    // Add reference images first
    for (const imgB64 of referenceImages.slice(0, 4)) {
        parts.push({ inlineData: { mimeType: 'image/png', data: imgB64 } });
    }
    
    let fullPrompt = buildEnhancedPrompt(prompt, style, appearanceParts, options);
    
    if (referenceImages.length > 0) {
        const refInstruction = `[CRITICAL: The reference image(s) above show the EXACT appearance of the character(s). You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features. Do not deviate from the reference appearances.]`;
        fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
    }
    
    parts.push({ text: fullPrompt });
    
    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio, imageSize }
        }
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
    
    const responseParts = candidates[0].content?.parts || [];
    for (const part of responseParts) {
        if (part.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        if (part.inline_data) return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
    }
    
    throw new Error('No image found in Gemini response');
}

function validateSettings() {
    const settings = getSettings();
    const errors = [];
    if (!settings.endpoint) errors.push('URL эндпоинта не настроен');
    if (!settings.apiKey) errors.push('API ключ не настроен');
    if (!settings.model) errors.push('Модель не выбрана');
    if (errors.length > 0) throw new Error(`Ошибка настроек: ${errors.join(', ')}`);
}

/**
 * Main generation function - collects all references and appearance, then generates
 */
async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    validateSettings();
    
    const settings = getSettings();
    const maxRetries = settings.maxRetries;
    const baseDelay = settings.retryDelay;
    
    onStatusUpdate?.('Сбор референсов...');
    
    // Collect references and appearances (char, user, NPCs)
    const { referenceImages, appearanceParts } = await collectReferencesAndAppearances();
    
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            onStatusUpdate?.(`Генерация${attempt > 0 ? ` (повтор ${attempt}/${maxRetries})` : ''}...`);
            
            if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
                return await generateImageGemini(prompt, style, referenceImages, appearanceParts, options);
            } else {
                return await generateImageOpenAI(prompt, style, referenceImages, appearanceParts, options);
            }
        } catch (error) {
            lastError = error;
            iigLog('ERROR', `Generation attempt ${attempt + 1} failed:`, error.message);
            
            const isRetryable = error.message?.match(/429|503|502|504|timeout|network/);
            if (!isRetryable || attempt === maxRetries) break;
            
            const delay = baseDelay * Math.pow(2, attempt);
            onStatusUpdate?.(`Повтор через ${delay / 1000}с...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    throw lastError;
}

// ============================================================
// FETCH HELPERS
// ============================================================

async function fetchModels() {
    const settings = getSettings();
    if (!settings.endpoint || !settings.apiKey) return [];
    
    try {
        const response = await fetch(`${settings.endpoint.replace(/\/$/, '')}/v1/models`, {
            headers: { 'Authorization': `Bearer ${settings.apiKey}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return (data.data || []).filter(m => isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        iigLog('ERROR', 'Failed to fetch models:', error.message);
        toastr.error(`Ошибка загрузки моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

async function fetchUserAvatars() {
    try {
        const context = SillyTavern.getContext();
        const response = await fetch('/api/avatars/get', {
            method: 'POST',
            headers: context.getRequestHeaders()
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        iigLog('ERROR', 'Failed to fetch user avatars:', error.message);
        return [];
    }
}

async function fetchCharactersList() {
    try {
        const context = SillyTavern.getContext();
        return (context.characters || []).map(c => ({ name: c.name, avatar: c.avatar })).filter(c => c.name);
    } catch (e) {
        return [];
    }
}

// ============================================================
// TAG PARSING
// ============================================================

async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];
    
    // NEW FORMAT: <img data-iig-instruction="{...}" src="...">
    const imgTagMarker = 'data-iig-instruction=';
    let searchPos = 0;
    
    while (true) {
        const markerPos = text.indexOf(imgTagMarker, searchPos);
        if (markerPos === -1) break;
        
        const imgStart = text.lastIndexOf('<img', markerPos);
        if (imgStart === -1 || markerPos - imgStart > 500) { searchPos = markerPos + 1; continue; }
        
        const afterMarker = markerPos + imgTagMarker.length;
        const jsonStart = text.indexOf('{', afterMarker);
        if (jsonStart === -1 || jsonStart > afterMarker + 10) { searchPos = markerPos + 1; continue; }
        
        let braceCount = 0, jsonEnd = -1, inString = false, escapeNext = false;
        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (char === '\\' && inString) { escapeNext = true; continue; }
            if (char === '"') { inString = !inString; continue; }
            if (!inString) {
                if (char === '{') braceCount++;
                else if (char === '}') { braceCount--; if (braceCount === 0) { jsonEnd = i + 1; break; } }
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
        
        const hasMarker = srcValue.includes('[IMG:GEN]') || srcValue.includes('[IMG:');
        const hasErrorImage = srcValue.includes('error.svg');
        const hasPath = srcValue && srcValue.startsWith('/') && srcValue.length > 5;
        
        if (hasErrorImage && !forceAll) { searchPos = imgEnd; continue; }
        
        let needsGeneration = false;
        if (forceAll) needsGeneration = true;
        else if (hasMarker || !srcValue) needsGeneration = true;
        else if (hasPath && checkExistence) {
            const exists = await checkFileExists(srcValue);
            if (!exists) needsGeneration = true;
        } else if (hasPath) { searchPos = imgEnd; continue; }
        
        if (!needsGeneration) { searchPos = imgEnd; continue; }
        
        try {
            const normalizedJson = instructionJson
                .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
                .replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
            const data = JSON.parse(normalizedJson);
            tags.push({
                fullMatch: fullImgTag, index: imgStart,
                style: data.style || '', prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: true, existingSrc: hasPath ? srcValue : null
            });
        } catch (e) {
            iigLog('WARN', `Failed to parse instruction JSON: ${instructionJson.substring(0, 100)}`);
        }
        
        searchPos = imgEnd;
    }
    
    // LEGACY FORMAT: [IMG:GEN:{...}]
    const marker = '[IMG:GEN:';
    let searchStart = 0;
    
    while (true) {
        const markerIndex = text.indexOf(marker, searchStart);
        if (markerIndex === -1) break;
        
        const jsonStart = markerIndex + marker.length;
        let braceCount = 0, jsonEnd = -1, inString = false, escapeNext = false;
        
        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (char === '\\' && inString) { escapeNext = true; continue; }
            if (char === '"') { inString = !inString; continue; }
            if (!inString) {
                if (char === '{') braceCount++;
                else if (char === '}') { braceCount--; if (braceCount === 0) { jsonEnd = i + 1; break; } }
            }
        }
        
        if (jsonEnd === -1) { searchStart = jsonStart; continue; }
        const jsonStr = text.substring(jsonStart, jsonEnd);
        if (!text.substring(jsonEnd).startsWith(']')) { searchStart = jsonEnd; continue; }
        
        try {
            const data = JSON.parse(jsonStr.replace(/'/g, '"'));
            tags.push({
                fullMatch: text.substring(markerIndex, jsonEnd + 1),
                index: markerIndex,
                style: data.style || '', prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: false
            });
        } catch (e) {
            iigLog('WARN', `Failed to parse legacy tag JSON`);
        }
        
        searchStart = jsonEnd + 1;
    }
    
    return tags;
}

async function checkFileExists(path) {
    try {
        const response = await fetch(path, { method: 'HEAD' });
        return response.ok;
    } catch (e) {
        return false;
    }
}

// ============================================================
// DOM HELPERS
// ============================================================

const ERROR_IMAGE_PATH = '/scripts/extensions/third-party/sillyimages/error.svg';

function createLoadingPlaceholder(tagId) {
    const placeholder = document.createElement('div');
    placeholder.className = 'iig-loading-placeholder';
    placeholder.dataset.tagId = tagId;
    placeholder.innerHTML = `<div class="iig-spinner"></div><div class="iig-status">Генерация картинки...</div>`;
    return placeholder;
}

function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = ERROR_IMAGE_PATH;
    img.alt = 'Ошибка генерации';
    img.title = `Ошибка: ${errorMessage}`;
    img.dataset.tagId = tagId;
    if (tagInfo.fullMatch) {
        const instructionMatch = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (instructionMatch) img.setAttribute('data-iig-instruction', instructionMatch[2]);
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
    if (processingMessages.has(messageId)) { iigLog('WARN', `Message ${messageId} already processing`); return; }
    
    const message = context.chat[messageId];
    if (!message || message.is_user) return;
    
    const tags = await parseImageTags(message.mes, { checkExistence: true });
    if (tags.length === 0) return;
    
    processingMessages.add(messageId);
    iigLog('INFO', `Found ${tags.length} image tag(s) in message ${messageId}`);
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
                const instruction = img.getAttribute('data-iig-instruction');
                const src = img.getAttribute('src') || '';
                if (instruction) {
                    const decoded = instruction.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
                    if (decoded.includes(searchPrompt)) { targetElement = img; break; }
                    try {
                        const d = JSON.parse(decoded.replace(/'/g, '"'));
                        if (d.prompt?.substring(0, 30) === tag.prompt.substring(0, 30)) { targetElement = img; break; }
                    } catch (e) { /* ignore */ }
                    if (instruction.includes(searchPrompt)) { targetElement = img; break; }
                }
            }
            
            if (!targetElement) {
                for (const img of allImgs) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]') || src === '' || src === '#') {
                        targetElement = img; break;
                    }
                }
            }
            
            if (!targetElement) {
                for (const img of mesTextEl.querySelectorAll('img')) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) { targetElement = img; break; }
                }
            }
        } else {
            const tagEscaped = tag.fullMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '(?:"|&quot;)');
            const before = mesTextEl.innerHTML;
            mesTextEl.innerHTML = mesTextEl.innerHTML.replace(new RegExp(tagEscaped, 'g'), `<span data-iig-placeholder="${tagId}"></span>`);
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
            const dataUrl = await generateImageWithRetry(
                tag.prompt, tag.style,
                (status) => { statusEl.textContent = status; },
                { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality }
            );
            
            statusEl.textContent = 'Сохранение...';
            const imagePath = await saveImageToFile(dataUrl);
            
            const img = document.createElement('img');
            img.className = 'iig-generated-image';
            img.src = imagePath;
            img.alt = tag.prompt;
            img.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;
            
            if (tag.isNewFormat) {
                const instructionMatch = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
                if (instructionMatch) img.setAttribute('data-iig-instruction', instructionMatch[2]);
            }
            
            loadingPlaceholder.replaceWith(img);
            
            if (tag.isNewFormat) {
                const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
                message.mes = message.mes.replace(tag.fullMatch, updatedTag);
            } else {
                message.mes = message.mes.replace(tag.fullMatch, `[IMG:✓:${imagePath}]`);
            }
            
            toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Failed tag ${index}:`, error.message);
            const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag);
            loadingPlaceholder.replaceWith(errorPlaceholder);
            
            if (tag.isNewFormat) {
                const errorTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${ERROR_IMAGE_PATH}"`);
                message.mes = message.mes.replace(tag.fullMatch, errorTag);
            } else {
                message.mes = message.mes.replace(tag.fullMatch, `[IMG:ERROR:${error.message.substring(0, 50)}]`);
            }
            
            toastr.error(`Ошибка: ${error.message}`, 'Генерация картинок');
        }
    };
    
    try {
        await Promise.all(tags.map((tag, index) => processTag(tag, index)));
    } finally {
        processingMessages.delete(messageId);
    }
    
    await context.saveChat();
}

async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message) { toastr.error('Сообщение не найдено', 'Генерация картинок'); return; }
    
    const tags = await parseImageTags(message.mes, { forceAll: true });
    if (tags.length === 0) { toastr.warning('Нет тегов для перегенерации', 'Генерация картинок'); return; }
    
    toastr.info(`Перегенерация ${tags.length} картинок...`, 'Генерация картинок');
    processingMessages.add(messageId);
    
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) { processingMessages.delete(messageId); return; }
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) { processingMessages.delete(messageId); return; }
    
    for (let index = 0; index < tags.length; index++) {
        const tag = tags[index];
        const tagId = `iig-regen-${messageId}-${index}`;
        
        try {
            const existingImg = mesTextEl.querySelector(`img[data-iig-instruction]`);
            if (existingImg) {
                const instruction = existingImg.getAttribute('data-iig-instruction');
                const loadingPlaceholder = createLoadingPlaceholder(tagId);
                existingImg.replaceWith(loadingPlaceholder);
                const statusEl = loadingPlaceholder.querySelector('.iig-status');
                
                const dataUrl = await generateImageWithRetry(
                    tag.prompt, tag.style,
                    (status) => { statusEl.textContent = status; },
                    { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality }
                );
                
                statusEl.textContent = 'Сохранение...';
                const imagePath = await saveImageToFile(dataUrl);
                
                const img = document.createElement('img');
                img.className = 'iig-generated-image';
                img.src = imagePath;
                img.alt = tag.prompt;
                if (instruction) img.setAttribute('data-iig-instruction', instruction);
                loadingPlaceholder.replaceWith(img);
                
                const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
                message.mes = message.mes.replace(tag.fullMatch, updatedTag);
                
                toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
            }
        } catch (error) {
            iigLog('ERROR', `Regen failed tag ${index}:`, error.message);
            toastr.error(`Ошибка: ${error.message}`, 'Генерация картинок');
        }
    }
    
    processingMessages.delete(messageId);
    await context.saveChat();
}

// ============================================================
// NPC MANAGER UI
// ============================================================

/**
 * Generate a unique ID for an NPC
 */
function generateNpcId() {
    return `npc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

/**
 * Render the NPC list in settings UI
 */
function renderNpcList() {
    const settings = getSettings();
    const container = document.getElementById('iig_npc_list');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (!settings.npcs || settings.npcs.length === 0) {
        container.innerHTML = '<p class="hint" style="text-align:center">НПС не добавлены</p>';
        return;
    }
    
    for (const npc of settings.npcs) {
        const item = document.createElement('div');
        item.className = 'iig-npc-item';
        item.dataset.npcId = npc.id;
        
        const avatarSrc = npc.avatarPath || '';
        item.innerHTML = `
            <div class="iig-npc-item-header">
                <label class="checkbox_label" style="margin:0">
                    <input type="checkbox" class="iig-npc-enabled" ${npc.enabled ? 'checked' : ''}>
                    <span class="iig-npc-name-display">${npc.name || 'Без имени'}</span>
                </label>
                <div class="iig-npc-controls">
                    <div class="iig-npc-avatar-preview" title="Аватар НПС">
                        ${avatarSrc ? `<img src="${avatarSrc}" style="width:24px;height:24px;border-radius:50%;object-fit:cover">` : '<i class="fa-solid fa-user" style="font-size:18px;opacity:0.5"></i>'}
                    </div>
                    <div class="menu_button iig-npc-edit-btn fa-solid fa-pen-to-square" title="Редактировать"></div>
                    <div class="menu_button iig-npc-delete-btn fa-solid fa-trash" title="Удалить" style="color:var(--SmartThemeQuoteColor,#c0392b)"></div>
                </div>
            </div>
            <div class="iig-npc-edit-panel" style="display:none; margin-top:8px; padding:8px; background:var(--SmartThemeBlurTintColor,rgba(0,0,0,0.1)); border-radius:4px;">
                <div class="flex-row" style="margin-bottom:6px">
                    <label style="min-width:80px">Имя</label>
                    <input type="text" class="text_pole flex1 iig-npc-name-input" value="${npc.name || ''}" placeholder="Имя НПС">
                </div>
                <div class="flex-row" style="margin-bottom:6px">
                    <label style="min-width:80px">Аватар</label>
                    <select class="flex1 iig-npc-avatar-select">
                        <option value="">-- Не выбран (поиск по имени) --</option>
                        ${avatarSrc ? `<option value="${avatarSrc}" selected>${avatarSrc}</option>` : ''}
                    </select>
                    <div class="menu_button iig-npc-refresh-avatars fa-solid fa-sync" title="Обновить список"></div>
                </div>
                <div class="flex-col" style="margin-bottom:6px">
                    <label>Описание внешности (текст, необязательно)</label>
                    <textarea class="text_pole iig-npc-description" rows="2" placeholder="Описание внешности НПС для подстановки в промпт...">${npc.description || ''}</textarea>
                </div>
                <div class="flex-row">
                    <div class="menu_button iig-npc-save-btn" style="flex:1; text-align:center">
                        <i class="fa-solid fa-floppy-disk"></i> Сохранить
                    </div>
                    <div class="menu_button iig-npc-test-btn" style="flex:1; text-align:center; margin-left:4px" title="Проверить обнаружение аватара">
                        <i class="fa-solid fa-magnifying-glass"></i> Найти аватар
                    </div>
                </div>
            </div>
        `;
        
        // Enabled toggle
        item.querySelector('.iig-npc-enabled').addEventListener('change', (e) => {
            const n = settings.npcs.find(x => x.id === npc.id);
            if (n) { n.enabled = e.target.checked; saveSettings(); }
        });
        
        // Edit toggle
        item.querySelector('.iig-npc-edit-btn').addEventListener('click', () => {
            const panel = item.querySelector('.iig-npc-edit-panel');
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
            // Load avatars when panel opens
            if (panel.style.display !== 'none') {
                loadNpcAvatarOptions(item, npc);
            }
        });
        
        // Delete
        item.querySelector('.iig-npc-delete-btn').addEventListener('click', () => {
            if (!confirm(`Удалить НПС "${npc.name}"?`)) return;
            settings.npcs = settings.npcs.filter(x => x.id !== npc.id);
            saveSettings();
            renderNpcList();
        });
        
        // Save
        item.querySelector('.iig-npc-save-btn').addEventListener('click', () => {
            const n = settings.npcs.find(x => x.id === npc.id);
            if (!n) return;
            n.name = item.querySelector('.iig-npc-name-input').value.trim();
            n.avatarPath = item.querySelector('.iig-npc-avatar-select').value;
            n.description = item.querySelector('.iig-npc-description').value;
            item.querySelector('.iig-npc-name-display').textContent = n.name || 'Без имени';
            // Update avatar preview
            const preview = item.querySelector('.iig-npc-avatar-preview');
            if (n.avatarPath) {
                preview.innerHTML = `<img src="${n.avatarPath}" style="width:24px;height:24px;border-radius:50%;object-fit:cover">`;
            } else {
                preview.innerHTML = '<i class="fa-solid fa-user" style="font-size:18px;opacity:0.5"></i>';
            }
            saveSettings();
            toastr.success(`НПС "${n.name}" сохранён`, 'Генерация картинок');
            // Clear vision cache for this NPC
            appearanceCache.delete(`npc_${n.id || n.name}`);
        });
        
        // Test avatar find
        item.querySelector('.iig-npc-test-btn').addEventListener('click', async () => {
            const n = settings.npcs.find(x => x.id === npc.id);
            if (!n) return;
            // Update name from input first
            n.name = item.querySelector('.iig-npc-name-input').value.trim() || n.name;
            toastr.info(`Поиск аватара для "${n.name}"...`, 'Генерация картинок');
            const result = await getNpcAvatarBase64(n);
            if (result) {
                // Update path in settings
                n.avatarPath = result.path;
                const select = item.querySelector('.iig-npc-avatar-select');
                // Add option if not exists
                let opt = Array.from(select.options).find(o => o.value === result.path);
                if (!opt) {
                    opt = document.createElement('option');
                    opt.value = result.path;
                    opt.textContent = result.path;
                    select.appendChild(opt);
                }
                select.value = result.path;
                saveSettings();
                toastr.success(`Аватар найден: ${result.path}`, 'Генерация картинок');
            } else {
                toastr.error(`Аватар для "${n.name}" не найден ни в /characters/, ни в /User Avatars/`, 'Генерация картинок');
            }
        });
        
        // Refresh avatars for this NPC
        item.querySelector('.iig-npc-refresh-avatars').addEventListener('click', () => loadNpcAvatarOptions(item, npc));
        
        container.appendChild(item);
    }
}

/**
 * Load avatar options for a specific NPC edit panel
 */
async function loadNpcAvatarOptions(itemEl, npc) {
    const select = itemEl.querySelector('.iig-npc-avatar-select');
    if (!select) return;
    
    const current = select.value;
    select.innerHTML = '<option value="">-- Не выбран (поиск по имени) --</option>';
    
    // Load ST characters
    const chars = await fetchCharactersList();
    for (const c of chars) {
        if (c.avatar) {
            const path = `/characters/${encodeURIComponent(c.avatar)}`;
            const opt = document.createElement('option');
            opt.value = path;
            opt.textContent = `[Персонаж] ${c.name} (${c.avatar})`;
            opt.selected = path === current || path === npc.avatarPath;
            select.appendChild(opt);
        }
    }
    
    // Load User Avatars
    const userAvatars = await fetchUserAvatars();
    for (const av of userAvatars) {
        const path = `/User Avatars/${encodeURIComponent(av)}`;
        const opt = document.createElement('option');
        opt.value = path;
        opt.textContent = `[Юзер] ${av}`;
        opt.selected = path === current || path === npc.avatarPath;
        select.appendChild(opt);
    }
}

// ============================================================
// SETTINGS UI
// ============================================================

function createSettingsUI() {
    const settings = getSettings();
    const container = document.getElementById('extensions_settings');
    if (!container) { console.error('[IIG] Settings container not found'); return; }
    
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
                    
                    <hr>
                    <h4>Настройки API</h4>
                    
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
                        <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть">
                            <i class="fa-solid fa-eye"></i>
                        </div>
                    </div>
                    
                    <div class="flex-row">
                        <label for="iig_model">Модель</label>
                        <select id="iig_model" class="flex1">
                            ${settings.model ? `<option value="${settings.model}" selected>${settings.model}</option>` : '<option value="">-- Выберите модель --</option>'}
                        </select>
                        <div id="iig_refresh_models" class="menu_button" title="Обновить список">
                            <i class="fa-solid fa-sync"></i>
                        </div>
                    </div>
                    
                    <hr>
                    <h4>Параметры генерации</h4>
                    
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
                    
                    <hr>
                    
                    <!-- Gemini / nano-banana section -->
                    <div id="iig_avatar_section" class="${settings.apiType !== 'gemini' ? 'hidden' : ''}">
                        <h4>Настройки Nano-Banana</h4>
                        
                        <div class="flex-row">
                            <label for="iig_aspect_ratio">Соотношение сторон</label>
                            <select id="iig_aspect_ratio" class="flex1">
                                <option value="1:1" ${settings.aspectRatio === '1:1' ? 'selected' : ''}>1:1</option>
                                <option value="2:3" ${settings.aspectRatio === '2:3' ? 'selected' : ''}>2:3</option>
                                <option value="3:2" ${settings.aspectRatio === '3:2' ? 'selected' : ''}>3:2</option>
                                <option value="3:4" ${settings.aspectRatio === '3:4' ? 'selected' : ''}>3:4</option>
                                <option value="4:3" ${settings.aspectRatio === '4:3' ? 'selected' : ''}>4:3</option>
                                <option value="4:5" ${settings.aspectRatio === '4:5' ? 'selected' : ''}>4:5</option>
                                <option value="5:4" ${settings.aspectRatio === '5:4' ? 'selected' : ''}>5:4</option>
                                <option value="9:16" ${settings.aspectRatio === '9:16' ? 'selected' : ''}>9:16</option>
                                <option value="16:9" ${settings.aspectRatio === '16:9' ? 'selected' : ''}>16:9</option>
                                <option value="21:9" ${settings.aspectRatio === '21:9' ? 'selected' : ''}>21:9</option>
                            </select>
                        </div>
                        
                        <div class="flex-row">
                            <label for="iig_image_size">Разрешение</label>
                            <select id="iig_image_size" class="flex1">
                                <option value="1K" ${settings.imageSize === '1K' ? 'selected' : ''}>1K</option>
                                <option value="2K" ${settings.imageSize === '2K' ? 'selected' : ''}>2K</option>
                                <option value="4K" ${settings.imageSize === '4K' ? 'selected' : ''}>4K</option>
                            </select>
                        </div>
                        
                        <hr>
                        <h5>📎 Референс-изображения</h5>
                        <p class="hint">Аватарки отправляются в API как визуальный референс.</p>
                        
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_send_char_avatar" ${settings.sendCharAvatar ? 'checked' : ''}>
                            <span>Отправлять аватар {{char}} как референс</span>
                        </label>
                        
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_send_user_avatar" ${settings.sendUserAvatar ? 'checked' : ''}>
                            <span>Отправлять аватар {{user}} как референс</span>
                        </label>
                        
                        <div id="iig_user_avatar_row" class="flex-row ${!settings.sendUserAvatar ? 'hidden' : ''}" style="margin-top:5px">
                            <label for="iig_user_avatar_file">Аватар {{user}}</label>
                            <select id="iig_user_avatar_file" class="flex1">
                                <option value="">-- Не выбран --</option>
                                ${settings.userAvatarFile ? `<option value="${settings.userAvatarFile}" selected>${settings.userAvatarFile}</option>` : ''}
                            </select>
                            <div id="iig_refresh_avatars" class="menu_button" title="Обновить список">
                                <i class="fa-solid fa-sync"></i>
                            </div>
                        </div>
                    </div>
                    
                    <hr>
                    
                    <!-- Vision Analysis Section -->
                    <h4>🔍 Vision-анализ аватарок</h4>
                    <p class="hint">Использует Vision API для анализа аватаров и извлечения описания внешности в текст промпта. Работает с любым Vision-совместимым API (GPT-4o, Claude и др.)</p>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_vision_enabled" ${settings.visionEnabled ? 'checked' : ''}>
                        <span>Включить Vision-анализ аватарок</span>
                    </label>
                    
                    <div id="iig_vision_section" class="${!settings.visionEnabled ? 'hidden' : ''}">
                        <div class="flex-row" style="margin-top:6px">
                            <label for="iig_vision_endpoint">Vision URL</label>
                            <input type="text" id="iig_vision_endpoint" class="text_pole flex1" 
                                   value="${settings.visionEndpoint}" 
                                   placeholder="Оставьте пустым для использования основного">
                        </div>
                        
                        <div class="flex-row">
                            <label for="iig_vision_api_key">Vision API ключ</label>
                            <input type="password" id="iig_vision_api_key" class="text_pole flex1" value="${settings.visionApiKey}">
                        </div>
                        
                        <div class="flex-row">
                            <label for="iig_vision_model">Vision модель</label>
                            <input type="text" id="iig_vision_model" class="text_pole flex1" 
                                   value="${settings.visionModel || 'gpt-4o-mini'}" 
                                   placeholder="gpt-4o-mini, claude-3-haiku, ...">
                        </div>
                        
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_vision_cache" ${settings.visionCacheEnabled !== false ? 'checked' : ''}>
                            <span>Кэшировать результаты анализа (рекомендуется)</span>
                        </label>
                        
                        <div class="flex-row" style="margin-top:6px">
                            <div id="iig_clear_vision_cache" class="menu_button" style="flex:1;text-align:center">
                                <i class="fa-solid fa-broom"></i> Очистить кэш анализа
                            </div>
                        </div>
                    </div>
                    
                    <hr>
                    
                    <!-- NPC Manager Section -->
                    <h4>👥 Менеджер НПС</h4>
                    <p class="hint">Добавляйте НПС с именами и аватарами. Если имя упоминается в чате, их внешность автоматически добавляется в промпт генерации.</p>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_npc_detect_chat" ${settings.npcDetectInChat ? 'checked' : ''}>
                        <span>Автоопределять НПС по упоминанию в чате</span>
                    </label>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_npc_send_ref" ${settings.npcSendAsReference ? 'checked' : ''}>
                        <span>Отправлять аватары НПС как референс</span>
                    </label>
                    
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_npc_analyze" ${settings.npcAnalyzeAppearance ? 'checked' : ''}>
                        <span>Анализировать аватары НПС через Vision</span>
                    </label>
                    
                    <div class="flex-row" style="margin-top:5px; margin-bottom:8px">
                        <label for="iig_npc_depth">Глубина поиска (сообщений)</label>
                        <input type="number" id="iig_npc_depth" class="text_pole flex1" 
                               value="${settings.npcChatSearchDepth || 10}" min="1" max="50">
                    </div>
                    
                    <div id="iig_npc_list" style="margin-bottom:8px">
                        <!-- NPC items rendered here -->
                    </div>
                    
                    <div class="flex-row">
                        <div id="iig_add_npc" class="menu_button" style="flex:1; text-align:center">
                            <i class="fa-solid fa-plus"></i> Добавить НПС
                        </div>
                    </div>
                    
                    <hr>
                    
                    <!-- Prompts Section -->
                    <h4>🎨 Пользовательские промпты</h4>
                    
                    <div class="flex-col" style="margin-bottom:8px">
                        <label for="iig_positive_prompt">Positive промпт</label>
                        <textarea id="iig_positive_prompt" class="text_pole" rows="2" 
                                  placeholder="masterpiece, best quality, detailed...">${settings.positivePrompt || ''}</textarea>
                    </div>
                    
                    <div class="flex-col" style="margin-bottom:8px">
                        <label for="iig_negative_prompt">Negative промпт</label>
                        <textarea id="iig_negative_prompt" class="text_pole" rows="2" 
                                  placeholder="low quality, blurry, deformed...">${settings.negativePrompt || ''}</textarea>
                    </div>
                    
                    <hr>
                    
                    <h4>🖼️ Фиксированный стиль</h4>
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_fixed_style_enabled" ${settings.fixedStyleEnabled ? 'checked' : ''}>
                        <span>Включить фиксированный стиль</span>
                    </label>
                    <input type="text" id="iig_fixed_style" class="text_pole" style="margin-top:5px"
                           value="${settings.fixedStyle || ''}" 
                           placeholder="Anime style, Avatar movie style, Cyberpunk 2077 style...">
                    
                    <hr>
                    
                    <h4>👤 Извлечение внешности (текст)</h4>
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_extract_appearance" ${settings.extractAppearance ? 'checked' : ''}>
                        <span>Извлекать внешность {{char}} из карточки</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_extract_user_appearance" ${settings.extractUserAppearance !== false ? 'checked' : ''}>
                        <span>Извлекать внешность {{user}} из персоны</span>
                    </label>
                    
                    <hr>
                    
                    <h4>👕 Определение одежды</h4>
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_detect_clothing" ${settings.detectClothing ? 'checked' : ''}>
                        <span>Определять одежду из чата</span>
                    </label>
                    <div class="flex-row" style="margin-top:5px">
                        <label for="iig_clothing_depth">Глубина поиска</label>
                        <input type="number" id="iig_clothing_depth" class="text_pole flex1" 
                               value="${settings.clothingSearchDepth || 5}" min="1" max="20">
                    </div>
                    
                    <hr>
                    
                    <h4>Обработка ошибок</h4>
                    <div class="flex-row">
                        <label for="iig_max_retries">Макс. повторов</label>
                        <input type="number" id="iig_max_retries" class="text_pole flex1" value="${settings.maxRetries}" min="0" max="5">
                    </div>
                    <div class="flex-row">
                        <label for="iig_retry_delay">Задержка (мс)</label>
                        <input type="number" id="iig_retry_delay" class="text_pole flex1" value="${settings.retryDelay}" min="500" max="10000" step="500">
                    </div>
                    
                    <hr>
                    
                    <h4>Отладка</h4>
                    <div class="flex-row">
                        <div id="iig_export_logs" class="menu_button" style="width:100%">
                            <i class="fa-solid fa-download"></i> Экспорт логов
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    container.insertAdjacentHTML('beforeend', html);
    bindSettingsEvents();
    renderNpcList();
}

function bindSettingsEvents() {
    const settings = getSettings();
    
    // Basic toggles
    document.getElementById('iig_enabled')?.addEventListener('change', (e) => { settings.enabled = e.target.checked; saveSettings(); });
    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        settings.apiType = e.target.value;
        saveSettings();
        document.getElementById('iig_avatar_section')?.classList.toggle('hidden', e.target.value !== 'gemini');
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
        settings.model = e.target.value;
        saveSettings();
        if (isGeminiModel(e.target.value)) {
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
            document.getElementById('iig_avatar_section')?.classList.remove('hidden');
            saveSettings();
        }
    });
    
    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');
        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');
            const current = settings.model;
            select.innerHTML = '<option value="">-- Выберите модель --</option>';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m; opt.textContent = m; opt.selected = m === current;
                select.appendChild(opt);
            }
            toastr.success(`Найдено моделей: ${models.length}`, 'Генерация картинок');
        } finally { btn.classList.remove('loading'); }
    });
    
    document.getElementById('iig_size')?.addEventListener('change', (e) => { settings.size = e.target.value; saveSettings(); });
    document.getElementById('iig_quality')?.addEventListener('change', (e) => { settings.quality = e.target.value; saveSettings(); });
    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => { settings.aspectRatio = e.target.value; saveSettings(); });
    document.getElementById('iig_image_size')?.addEventListener('change', (e) => { settings.imageSize = e.target.value; saveSettings(); });
    
    document.getElementById('iig_send_char_avatar')?.addEventListener('change', (e) => { settings.sendCharAvatar = e.target.checked; saveSettings(); });
    document.getElementById('iig_send_user_avatar')?.addEventListener('change', (e) => {
        settings.sendUserAvatar = e.target.checked;
        saveSettings();
        document.getElementById('iig_user_avatar_row')?.classList.toggle('hidden', !e.target.checked);
    });
    document.getElementById('iig_user_avatar_file')?.addEventListener('change', (e) => { settings.userAvatarFile = e.target.value; saveSettings(); });
    document.getElementById('iig_refresh_avatars')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const avatars = await fetchUserAvatars();
            const select = document.getElementById('iig_user_avatar_file');
            const current = settings.userAvatarFile;
            select.innerHTML = '<option value="">-- Не выбран --</option>';
            for (const av of avatars) {
                const opt = document.createElement('option');
                opt.value = av; opt.textContent = av; opt.selected = av === current;
                select.appendChild(opt);
            }
            toastr.success(`Найдено аватаров: ${avatars.length}`, 'Генерация картинок');
        } finally { btn.classList.remove('loading'); }
    });
    
    // Vision settings
    document.getElementById('iig_vision_enabled')?.addEventListener('change', (e) => {
        settings.visionEnabled = e.target.checked;
        saveSettings();
        document.getElementById('iig_vision_section')?.classList.toggle('hidden', !e.target.checked);
    });
    document.getElementById('iig_vision_endpoint')?.addEventListener('input', (e) => { settings.visionEndpoint = e.target.value; saveSettings(); });
    document.getElementById('iig_vision_api_key')?.addEventListener('input', (e) => { settings.visionApiKey = e.target.value; saveSettings(); });
    document.getElementById('iig_vision_model')?.addEventListener('input', (e) => { settings.visionModel = e.target.value; saveSettings(); });
    document.getElementById('iig_vision_cache')?.addEventListener('change', (e) => { settings.visionCacheEnabled = e.target.checked; saveSettings(); });
    document.getElementById('iig_clear_vision_cache')?.addEventListener('click', () => {
        appearanceCache.clear();
        toastr.success('Кэш Vision-анализа очищен', 'Генерация картинок');
    });
    
    // NPC Manager
    document.getElementById('iig_npc_detect_chat')?.addEventListener('change', (e) => { settings.npcDetectInChat = e.target.checked; saveSettings(); });
    document.getElementById('iig_npc_send_ref')?.addEventListener('change', (e) => { settings.npcSendAsReference = e.target.checked; saveSettings(); });
    document.getElementById('iig_npc_analyze')?.addEventListener('change', (e) => { settings.npcAnalyzeAppearance = e.target.checked; saveSettings(); });
    document.getElementById('iig_npc_depth')?.addEventListener('input', (e) => { settings.npcChatSearchDepth = parseInt(e.target.value) || 10; saveSettings(); });
    
    document.getElementById('iig_add_npc')?.addEventListener('click', () => {
        if (!settings.npcs) settings.npcs = [];
        const newNpc = {
            id: generateNpcId(),
            name: '',
            enabled: true,
            avatarPath: '',
            description: ''
        };
        settings.npcs.push(newNpc);
        saveSettings();
        renderNpcList();
        // Auto-open edit panel for the new NPC
        const lastItem = document.querySelector('#iig_npc_list .iig-npc-item:last-child');
        if (lastItem) {
            const panel = lastItem.querySelector('.iig-npc-edit-panel');
            if (panel) {
                panel.style.display = 'block';
                loadNpcAvatarOptions(lastItem, newNpc);
            }
        }
    });
    
    // Prompts & style
    document.getElementById('iig_positive_prompt')?.addEventListener('input', (e) => { const s = getSettings(); s.positivePrompt = e.target.value; saveSettings(); });
    document.getElementById('iig_negative_prompt')?.addEventListener('input', (e) => { const s = getSettings(); s.negativePrompt = e.target.value; saveSettings(); });
    document.getElementById('iig_fixed_style_enabled')?.addEventListener('change', (e) => { const s = getSettings(); s.fixedStyleEnabled = e.target.checked; saveSettings(); });
    document.getElementById('iig_fixed_style')?.addEventListener('input', (e) => { const s = getSettings(); s.fixedStyle = e.target.value; saveSettings(); });
    
    // Appearance & clothing
    document.getElementById('iig_extract_appearance')?.addEventListener('change', (e) => { const s = getSettings(); s.extractAppearance = e.target.checked; saveSettings(); });
    document.getElementById('iig_extract_user_appearance')?.addEventListener('change', (e) => { const s = getSettings(); s.extractUserAppearance = e.target.checked; saveSettings(); });
    document.getElementById('iig_detect_clothing')?.addEventListener('change', (e) => { const s = getSettings(); s.detectClothing = e.target.checked; saveSettings(); });
    document.getElementById('iig_clothing_depth')?.addEventListener('input', (e) => { const s = getSettings(); s.clothingSearchDepth = parseInt(e.target.value) || 5; saveSettings(); });
    
    // Retries
    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => { settings.maxRetries = parseInt(e.target.value) || 0; saveSettings(); });
    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => { settings.retryDelay = parseInt(e.target.value) || 1000; saveSettings(); });
    
    // Logs
    document.getElementById('iig_export_logs')?.addEventListener('click', exportLogs);
}

// ============================================================
// MESSAGE BUTTONS
// ============================================================

function addRegenerateButton(messageElement, messageId) {
    if (messageElement.querySelector('.iig-regenerate-btn')) return;
    const extraMesButtons = messageElement.querySelector('.extraMesButtons');
    if (!extraMesButtons) return;
    
    const btn = document.createElement('div');
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = 'Перегенерировать картинки';
    btn.tabIndex = 0;
    btn.addEventListener('click', async (e) => { e.stopPropagation(); await regenerateMessageImages(messageId); });
    extraMesButtons.appendChild(btn);
}

function addButtonsToExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat || context.chat.length === 0) return;
    
    let count = 0;
    for (const el of document.querySelectorAll('#chat .mes')) {
        const mesId = el.getAttribute('mesid');
        if (mesId === null) continue;
        const id = parseInt(mesId, 10);
        const msg = context.chat[id];
        if (msg && !msg.is_user) { addRegenerateButton(el, id); count++; }
    }
    iigLog('INFO', `Added regenerate buttons to ${count} messages`);
}

// ============================================================
// EVENT HANDLERS
// ============================================================

async function onMessageReceived(messageId) {
    iigLog('INFO', `onMessageReceived: ${messageId}`);
    const settings = getSettings();
    if (!settings.enabled) return;
    
    const context = SillyTavern.getContext();
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    
    addRegenerateButton(messageElement, messageId);
    await processMessageTags(messageId);
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
        console.log('[IIG] Inline Image Generation extension loaded (with NPC Manager + Vision)');
    });
    
    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        // Clear per-session vision cache on chat change (optional - keeps it fresh)
        // appearanceCache.clear();
        setTimeout(() => addButtonsToExistingMessages(), 100);
    });
    
    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
        iigLog('INFO', `CHARACTER_MESSAGE_RENDERED: ${messageId}`);
        await onMessageReceived(messageId);
    });
    
    console.log('[IIG] Inline Image Generation extension initialized');
})();
