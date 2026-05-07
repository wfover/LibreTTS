let expiredAt = null;
let endpoint = null;
let clientId = "76a75279-2ffa-4c3d-8db8-7b47252aa41c";

/**
 * OpenAI Compatible TTS API Handler
 * Endpoint: /v1/audio/speech
 * Format: OpenAI TTS API compatible
 */
export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  // Handle OPTIONS request (preflight)
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    if (req.method === "POST") {
      const body = req.body;
      
      // OpenAI format parameters
      const input = body.input || "";
      const voiceName = body.voice || "zh-CN-XiaoxiaoMultilingualNeural";
      const speed = Number(body.speed) || 1.0; // OpenAI default is 1.0
      const responseFormat = body.response_format || "mp3";
      const model = body.model || "tts-1"; // Ignored, but kept for compatibility
      
      // Validate input
      if (!input || input.trim() === "") {
        return res.status(400).json({ 
          error: { 
            message: "Invalid input: text cannot be empty",
            type: "invalid_request_error",
            code: "invalid_input"
          } 
        });
      }
      
      // Validate speed (OpenAI accepts 0.25 to 4.0)
      if (speed < 0.25 || speed > 4.0) {
        return res.status(400).json({ 
          error: { 
            message: "Invalid speed: must be between 0.25 and 4.0",
            type: "invalid_request_error",
            code: "invalid_speed"
          } 
        });
      }
      
      // Convert OpenAI parameters to Edge TTS format
      // OpenAI speed: 0.25 (25%) to 4.0 (400%)
      // Edge rate: -50% to +50% (where 0 is 100%)
      // Conversion: rate = (speed - 1.0) * 100, clamped to [-50, 50]
      let rate = (speed - 1.0) * 100;
      rate = Math.max(-50, Math.min(50, rate));
      
      // Map response format to Edge TTS output format
      const formatMap = {
        "mp3": "audio-24khz-48kbitrate-mono-mp3",
        "opus": "audio-24khz-16kbitrate-mono-opus",
        "aac": "audio-24khz-48kbitrate-mono-mp3", // Fallback to mp3
        "flac": "audio-24khz-48kbitrate-mono-mp3", // Fallback to mp3
        "wav": "riff-24khz-16bit-mono-pcm",
        "pcm": "raw-24khz-16bit-mono-pcm"
      };
      
      const outputFormat = formatMap[responseFormat] || formatMap["mp3"];
      
      // Use existing TTS handler with converted parameters
      return await handleTTS(res, input, voiceName, rate, 0, outputFormat, responseFormat);
      
    } else {
      return res.status(405).json({ 
        error: { 
          message: "Method not allowed",
          type: "invalid_request_error",
          code: "method_not_allowed"
        } 
      });
    }
  } catch (error) {
    console.error("OpenAI TTS API Error:", error);
    return res.status(500).json({ 
      error: { 
        message: error.message || "Internal Server Error",
        type: "internal_error",
        code: "internal_error"
      } 
    });
  }
}

async function handleTTS(res, text, voiceName, rate, pitch, outputFormat, responseFormat) {
  try {
    await refreshEndpoint();
    
    // Generate SSML
    const ssml = generateSsml(text, voiceName, rate, pitch);
    
    // Get URL from endpoint
    const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;
    
    // Set up headers
    const headers = {
      "Authorization": endpoint.t,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": outputFormat,
      "User-Agent": "okhttp/4.5.0",
      "Origin": "https://azure.microsoft.com",
      "Referer": "https://azure.microsoft.com/"
    };
    
    // Make the request to Microsoft's TTS service
    const response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: ssml
    });
  
    // Handle errors
    if (!response.ok) {
      throw new Error(`TTS request failed with status ${response.status}`);
    }
  
    // Set appropriate content type based on response format
    const contentTypeMap = {
      "mp3": "audio/mpeg",
      "opus": "audio/opus",
      "aac": "audio/aac",
      "flac": "audio/flac",
      "wav": "audio/wav",
      "pcm": "audio/pcm"
    };
    
    const contentType = contentTypeMap[responseFormat] || "audio/mpeg";
    res.setHeader("Content-Type", contentType);
    
    // Get the audio data and send it
    const audioData = await response.arrayBuffer();
    const buffer = Buffer.from(audioData);
    return res.send(buffer);
  } catch (error) {
    console.error("TTS Error:", error);
    return res.status(500).json({ 
      error: { 
        message: error.message,
        type: "internal_error",
        code: "tts_generation_failed"
      } 
    });
  }
}

// 清理 Markdown 标记，避免被朗读
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
  // 5) 数字列表 1. 2. 等
  text = text.replace(/^\s*\d+\.\s+/gm, '');
  // 6) 加粗/斜体 **text** *text* __text__ _text_
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/_([^_]+)_/g, '$1');
  // 7) 链接与图片 [text](url) ![alt](url)
  text = text.replace(/!\[[^\]]*\]\([^\)]*\)/g, '');
  text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
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

function generateSsml(text, voiceName, rate, pitch) {
  // 先清理 Markdown，再生成 SSML
  const cleanText = stripMarkdown(text);
  
  return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN"> 
              <voice name="${voiceName}"> 
                  <mstts:express-as style="general" styledegree="1.0" role="default"> 
                      <prosody rate="${rate}%" pitch="${pitch}%" volume="50">${cleanText}</prosody> 
                  </mstts:express-as> 
              </voice> 
          </speak>`;
}

async function refreshEndpoint() {
  if (!expiredAt || Date.now() / 1000 > expiredAt - 60) {
    try {
      endpoint = await getEndpoint();
      
      // Parse JWT token to get expiry time
      const parts = endpoint.t.split(".");
      if (parts.length >= 2) {
        const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(
          atob(base64)
            .split('')
            .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            .join('')
        );
        
        const decodedJwt = JSON.parse(jsonPayload);
        expiredAt = decodedJwt.exp;
      } else {
        // Default expiry if we can't parse the token
        expiredAt = (Date.now() / 1000) + 3600;
      }
      
      clientId = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).substring(2, 15);
      console.log(`获取 Endpoint, 过期时间剩余: ${((expiredAt - Date.now() / 1000) / 60).toFixed(2)} 分钟`);
    } catch (error) {
      console.error("无法获取或解析Endpoint:", error);
      throw error;
    }
  } else {
    console.log(`过期时间剩余: ${((expiredAt - Date.now() / 1000) / 60).toFixed(2)} 分钟`);
  }
}

async function getEndpoint() {
  const endpointUrl = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
  const headers = {
    "Accept-Language": "zh-Hans",
    "X-ClientVersion": "4.0.530a 5fe1dc6c",
    "X-UserId": "0f04d16a175c411e",
    "X-HomeGeographicRegion": "zh-Hans-CN",
    "X-ClientTraceId": clientId || "76a75279-2ffa-4c3d-8db8-7b47252aa41c",
    "X-MT-Signature": await generateSignature(endpointUrl),
    "User-Agent": "okhttp/4.5.0",
    "Content-Type": "application/json; charset=utf-8",
    "Accept-Encoding": "gzip"
  };
  
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: headers
  });
  
  if (!response.ok) {
    throw new Error(`获取 Endpoint 失败，状态码 ${response.status}`);
  }
  
  return await response.json();
}

async function generateSignature(urlStr) {
  try {
    const url = urlStr.split("://")[1];
    const encodedUrl = encodeURIComponent(url);
    const uuidStr = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).substring(2, 15);
    const formattedDate = formatDate();
    const bytesToSign = `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();
    
    // Import the key for signing
    const keyData = base64ToArrayBuffer("oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==");
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: { name: 'SHA-256' } },
      false,
      ['sign']
    );
    
    // Sign the data
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(bytesToSign)
    );
    
    // Convert the signature to base64
    const signatureBase64 = arrayBufferToBase64(signature);
    
    return `MSTranslatorAndroidApp::${signatureBase64}::${formattedDate}::${uuidStr}`;
  } catch (error) {
    console.error("Generate signature error:", error);
    throw error;
  }
}

function formatDate() {
  const date = new Date();
  const utcString = date.toUTCString().replace(/GMT/, "").trim() + " GMT";
  return utcString.toLowerCase();
}

// Helper functions
function base64ToArrayBuffer(base64) {
  const binary_string = atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function atob(str) {
  return Buffer.from(str, 'base64').toString('binary');
}

function btoa(str) {
  return Buffer.from(str, 'binary').toString('base64');
}

