let expiredAt = null;
let endpoint = null;
let clientId = "76a75279-2ffa-4c3d-8db8-7b47252aa41c";

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-auth-token");
  
  // Handle OPTIONS request (preflight)
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    if (req.method === "POST") {
      const body = req.body;
      const text = body.text || "";
      const voiceName = body.voice || "zh-CN-XiaoxiaoMultilingualNeural";
      const rate = Number(body.rate) || 0;
      const pitch = Number(body.pitch) || 0;
      const outputFormat = body.format || "audio-24khz-48kbitrate-mono-mp3";
      const download = body.preview === false;
      
      return await handleTTS(res, text, voiceName, rate, pitch, outputFormat, download);
    } else if (req.method === "GET") {
      const { query } = req;
      const text = query.t || "";
      const voiceName = query.v || "zh-CN-XiaoxiaoMultilingualNeural";
      const rate = Number(query.r) || 0;
      const pitch = Number(query.p) || 0;
      const outputFormat = query.o || "audio-24khz-48kbitrate-mono-mp3";
      const download = query.d === "true";
      
      return await handleTTS(res, text, voiceName, rate, pitch, outputFormat, download);
    } else {
      return res.status(405).json({ error: "Method not allowed" });
    }
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: error.message || "Internal Server Error" });
  }
}

async function handleTTS(res, text, voiceName, rate, pitch, outputFormat, download) {
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
      throw new Error(`TTS 请求失败，状态码 ${response.status}`);
    }
  
    // Set appropriate headers
    res.setHeader("Content-Type", "audio/mpeg");
    
    if (download) {
      res.setHeader("Content-Disposition", `attachment; filename="${voiceName}.mp3"`);
    }
    
    // Get the audio data and send it
    const audioData = await response.arrayBuffer();
    const buffer = Buffer.from(audioData);
    return res.send(buffer);
  } catch (error) {
    console.error("TTS Error:", error);
    return res.status(500).json({ error: error.message });
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
  // 9) 分隔线：连续 3 个及以上相同分隔符
  text = text.replace(/^\s*([*\-=+_])\1{2,}\s*$/gm, '');
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
