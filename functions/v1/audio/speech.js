let expiredAt = null;
let endpoint = null;
let clientId = "76a75279-2ffa-4c3d-8db8-7b47252aa41c";

/**
 * OpenAI Compatible TTS API Handler
 * Endpoint: /v1/audio/speech
 * Format: OpenAI TTS API compatible
 * Platform: Cloudflare Pages Functions
 */
export async function onRequest(context) {
  const { request, env } = context;
  
  // Handle OPTIONS request (preflight)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      }
    });
  }

  // Only allow POST method
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ 
      error: { 
        message: "Method not allowed. Use POST.",
        type: "invalid_request_error",
        code: "method_not_allowed"
      } 
    }), {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      }
    });
  }

  try {
    const body = await request.json();
    
    // OpenAI format parameters
    const input = body.input || "";
    const voiceName = body.voice || "zh-CN-XiaoxiaoMultilingualNeural";
    const speed = Number(body.speed) || 1.0; // OpenAI default is 1.0
    const responseFormat = body.response_format || "mp3";
    const model = body.model || "tts-1"; // Ignored, but kept for compatibility
    
    // Validate input
    if (!input || input.trim() === "") {
      return new Response(JSON.stringify({ 
        error: { 
          message: "Invalid input: text cannot be empty",
          type: "invalid_request_error",
          code: "invalid_input"
        } 
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        }
      });
    }
    
    // Validate speed (OpenAI accepts 0.25 to 4.0)
    if (speed < 0.25 || speed > 4.0) {
      return new Response(JSON.stringify({ 
        error: { 
          message: "Invalid speed: must be between 0.25 and 4.0",
          type: "invalid_request_error",
          code: "invalid_speed"
        } 
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
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

    // Split long text into chunks for reliable TTS generation
    const chunks = splitTextForTTS(input);

    if (chunks.length <= 1) {
      // Short text: single request (handleTTS internally strips markdown)
      return await handleTTS(input, voiceName, rate, 0, outputFormat, responseFormat, env);
    }

    // Long text: process chunks and concatenate audio
    console.log(`Long text detected (${input.length} chars), splitting into ${chunks.length} chunks`);
    const audioBuffers = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkResponse = await handleTTS(chunks[i], voiceName, rate, 0, outputFormat, responseFormat, env);
      if (!chunkResponse.ok) {
        const errBody = await chunkResponse.text().catch(() => '');
        throw new Error(`Chunk ${i + 1}/${chunks.length} failed (${chunkResponse.status}): ${errBody}`);
      }
      const buffer = await chunkResponse.arrayBuffer();
      if (buffer.byteLength > 0) {
        audioBuffers.push(new Uint8Array(buffer));
      }
    }

    // Concatenate all audio chunks (MP3 frames are independent, direct concat works)
    const totalLength = audioBuffers.reduce((sum, buf) => sum + buf.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const buf of audioBuffers) {
      combined.set(buf, offset);
      offset += buf.byteLength;
    }

    const contentTypeMap = {
      "mp3": "audio/mpeg",
      "opus": "audio/opus",
      "aac": "audio/aac",
      "flac": "audio/flac",
      "wav": "audio/wav",
      "pcm": "audio/pcm"
    };

    return new Response(combined.buffer, {
      status: 200,
      headers: {
        "Content-Type": contentTypeMap[responseFormat] || "audio/mpeg",
        "Access-Control-Allow-Origin": "*",
      }
    });
    
  } catch (error) {
    console.error("OpenAI TTS API Error:", error);
    return new Response(JSON.stringify({ 
      error: { 
        message: error.message || "Internal Server Error",
        type: "internal_error",
        code: "internal_error"
      } 
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      }
    });
  }
}

async function handleTTS(text, voiceName, rate, pitch, outputFormat, responseFormat, env = null) {
  const ssml = generateSsml(text, voiceName, rate, pitch);
  const contentTypeMap = {
    "mp3": "audio/mpeg",
    "opus": "audio/opus",
    "aac": "audio/aac",
    "flac": "audio/flac",
    "wav": "audio/wav",
    "pcm": "audio/pcm"
  };
  const contentType = contentTypeMap[responseFormat] || "audio/mpeg";

  // 1) 先尝试 Edge TTS（免费）
  try {
    await refreshEndpoint();

    const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": endpoint.t,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": outputFormat,
        "User-Agent": "okhttp/4.5.0",
        "Origin": "https://azure.microsoft.com",
        "Referer": "https://azure.microsoft.com/"
      },
      body: ssml
    });

    if (!response.ok) {
      throw new Error(`Edge TTS failed with status ${response.status}`);
    }

    const audioData = await response.arrayBuffer();
    return new Response(audioData, {
      status: 200,
      headers: { "Content-Type": contentType, "Access-Control-Allow-Origin": "*" }
    });
  } catch (edgeError) {
    console.error("Edge TTS Error:", edgeError);

    // 2) Edge 失败，回退到 Azure TTS（需要 env 中配置 AZURE_TTS_KEY）
    if (env && env.AZURE_TTS_KEY) {
      console.log("Edge TTS 失败，回退到 Azure TTS...");
      try {
        const azureRegion = env.AZURE_TTS_REGION || "eastus";
        const azureUrl = `https://${azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;
        const azureResponse = await fetch(azureUrl, {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": env.AZURE_TTS_KEY,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": outputFormat,
            "User-Agent": "LibreTTS"
          },
          body: ssml
        });

        if (!azureResponse.ok) {
          throw new Error(`Azure TTS also failed with status ${azureResponse.status}`);
        }

        console.log("Azure TTS 回退成功");
        const audioData = await azureResponse.arrayBuffer();
        return new Response(audioData, {
          status: 200,
          headers: { "Content-Type": contentType, "Access-Control-Allow-Origin": "*" }
        });
      } catch (azureError) {
        console.error("Azure TTS 回退也失败:", azureError);
        return new Response(JSON.stringify({
          error: {
            message: `Edge TTS 和 Azure TTS 均失败: ${azureError.message}`,
            type: "internal_error",
            code: "tts_generation_failed"
          }
        }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // 没有 Azure 配置，直接返回 Edge 错误
    return new Response(JSON.stringify({
      error: {
        message: edgeError.message,
        type: "internal_error",
        code: "tts_generation_failed"
      }
    }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
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
        const padding = '='.repeat((4 - base64.length % 4) % 4);
        const base64Padded = base64 + padding;
        const jsonPayload = atob(base64Padded);
        
        const decodedJwt = JSON.parse(jsonPayload);
        expiredAt = decodedJwt.exp;
      } else {
        // Default expiry if we can't parse the token
        expiredAt = (Date.now() / 1000) + 3600;
      }
      
      clientId = crypto.randomUUID().replace(/-/g, "");
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
    const uuidStr = crypto.randomUUID().replace(/-/g, "");
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

// --- Long text chunking ---
const TTS_CHUNK_THRESHOLD = 2000;

// Split text at sentence boundaries (no lookbehind regex for CF Workers compatibility)
function splitBySentences(text) {
  const sentenceEnders = '。！？.!?\n';
  const segments = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    current += text[i];
    if (sentenceEnders.includes(text[i])) {
      if (current.trim()) segments.push(current);
      current = '';
    }
  }
  if (current.trim()) segments.push(current);
  return segments;
}

function splitBySecondary(text) {
  const delimiters = '，,；;：:、';
  const segments = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    current += text[i];
    if (delimiters.includes(text[i])) {
      if (current.trim()) segments.push(current);
      current = '';
    }
  }
  if (current.trim()) segments.push(current);
  return segments;
}

function splitTextForTTS(text) {
  text = text.trim();
  if (text.length <= TTS_CHUNK_THRESHOLD) return [text];

  // Step 1: Split by sentence-ending punctuation and newlines
  const rawSegments = splitBySentences(text);

  // Step 2: Merge short segments, respect max length
  const merged = [];
  let buffer = '';
  for (const seg of rawSegments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    if (buffer && buffer.length + trimmed.length > TTS_CHUNK_THRESHOLD) {
      merged.push(buffer.trim());
      buffer = trimmed;
    } else {
      buffer += seg;
    }
  }
  if (buffer.trim()) merged.push(buffer.trim());

  // Step 3: Further split chunks still too long by secondary delimiters
  const result = [];
  for (const chunk of merged) {
    if (chunk.length <= TTS_CHUNK_THRESHOLD * 1.2) {
      result.push(chunk);
      continue;
    }
    const subSegments = splitBySecondary(chunk);
    let subBuffer = '';
    for (const sub of subSegments) {
      if (subBuffer && subBuffer.length + sub.length > TTS_CHUNK_THRESHOLD) {
        result.push(subBuffer.trim());
        subBuffer = sub;
      } else {
        subBuffer += sub;
      }
    }
    if (subBuffer.trim()) result.push(subBuffer.trim());
  }

  // Step 4: Hard split anything still excessively long
  const final = [];
  for (const r of result) {
    if (r.length <= TTS_CHUNK_THRESHOLD * 1.5) {
      final.push(r);
    } else {
      for (let i = 0; i < r.length; i += TTS_CHUNK_THRESHOLD) {
        final.push(r.substring(i, i + TTS_CHUNK_THRESHOLD));
      }
    }
  }

  return final.length > 0 ? final : [text];
}
