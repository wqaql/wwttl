// deno run --allow-net main.ts
// @ts-ignore: Deno模块导入
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
// @ts-ignore: Deno模块导入
import {encodeBase64, decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

// 为Deno API添加类型声明
declare global {
  interface ResponseConstructor {
    json(data: any): Response;
  }
}

const PORT = 8000;
const CACHE_TTL = 5 * 60 * 1000; // 缓存有效期：5分钟

// 简单的内存缓存实现
interface CacheItem<T> {
  data: T;
  timestamp: number;
}

class MemoryCache {
  private cache: Map<string, CacheItem<any>> = new Map();

  get<T>(key: string): T | null {
    const item = this.cache.get(key);
    if (!item) return null;

    // 检查缓存是否过期
    if (Date.now() - item.timestamp > CACHE_TTL) {
      this.cache.delete(key);
      return null;
    }

    return item.data as T;
  }

  set<T>(key: string, data: T): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  // 清理过期缓存
  cleanup(): void {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (now - item.timestamp > CACHE_TTL) {
        this.cache.delete(key);
      }
    }
  }
}

// 创建缓存实例
const cache = new MemoryCache();

// 定期清理缓存
setInterval(() => cache.cleanup(), CACHE_TTL);

// 特定 user-agent，用于模拟手机浏览器访问
const iPhoneUserAgent =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

async function handleRequest(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const pathname = url.pathname + url.search;
    const cacheKey = `${req.method}:${pathname}`;

    // 检查缓存（仅对GET请求）
    if (req.method === "GET") {
      const cachedResponse = cache.get<{body: ArrayBuffer; status: number; headers: Headers}>(cacheKey);
      if (cachedResponse) {
        return new Response(cachedResponse.body, {
          status: cachedResponse.status,
          headers: cachedResponse.headers,
        });
      }
    }

    // 1. 获取并解析天气数据
    if (pathname === "/weathercn-data/") {
      return await handleWeatherCnData(cacheKey,url);
    }

    // 2. 代理请求：/mpf/*
    if (pathname.startsWith("/mpf/")) {
      const target = "https://mpf.weather.com.cn" + pathname.replace("/mpf", "");
      return await fetchProxyWithCache(req, target, cacheKey);
    }

    // 3. 特别处理 /duanlin/* 返回加工后的降水图数据
    if (pathname.startsWith("/duanlin/")) {
      return await handleDuanlinData(pathname, cacheKey,url);
    }

    // 4. 小米代理
    if (pathname.startsWith("/wtr-v3/")) {
      const target = "https://weatherapi.market.xiaomi.com/wtr-v3" +
        pathname.replace("/wtr-v3", "");
      return await fetchProxyWithCache(req, target, cacheKey);
    }

    // 5. 图片代理 /img/*
    if (pathname.startsWith("/img/")) {
      console.log(pathname)
      return await handleImageProxy(pathname, cacheKey);
    }

    // 6. d3代理
    if (pathname.startsWith("/d3/")) {
      const target = "https://d3.weather.com.cn" + pathname.replace("/d3", "");
      return await fetchProxyWithCache(req, target, cacheKey);
    }

    // 7. d4代理
    if (pathname.startsWith("/d4/")) {
      const target = "https://d4.weather.com.cn" + pathname.replace("/d4", "");
      return await fetchProxyWithCache(req, target, cacheKey);
    }

    return new Response("Not Found", { status: 404 });
  } catch (error) {
    console.error("Request handling error:", error);
    return new Response(`Server Error: ${error.message}`, { status: 500 });
  }
}

// 处理天气数据
async function handleWeatherCnData(cacheKey: string,url:URL): Promise<Response> {
  try {
    const res = await fetch("https://m.weathercn.com/weatherMap.do?partner=1000001071_hfaw&language=zh-cn&id=2332685&p_source=&p_type=jump&seadId=&cpoikey=", {
      headers: {
        "User-Agent": iPhoneUserAgent,
        "Host": "m.weathercn.com",
      },
    });

    const html = await res.text();
    const match = html.match(/let\s+DATA\s*=\s*(\{[\s\S]+?\});/);

    if (!match) {
      return new Response("DATA not found", { status: 500 });
    }

    const DATA = new Function(`${match[0]}; return DATA;`)(); // ⚠️ 请确保来源可信
    for (const key in DATA) {
      const item = DATA[key];
      if (item.pic!=null) {
        for (let i = 0; i < item.pic.length; i++) {
          item.pic[i] = getProxyImageUrl(url.origin,item.pic[i]);
        }
      }else {
        for (let i = 0; i < item.result.picture_url.length; i++) {
          item.result.picture_url[i] = getProxyImageUrl(url.origin,item.result.picture_url[i]);
        }
      }

    }
    const response = Response.json(DATA);

    // 缓存响应
    cacheResponse(response.clone(), cacheKey);

    return response;
  } catch (err) {
    console.error("Error fetching weather data:", err);
    return new Response("Error fetching weather data: " + err.message, {
      status: 500,
    });
  }
}

// 处理短临降水数据
async function handleDuanlinData(pathname: string, cacheKey: string,url:URL): Promise<Response> {
  try {
    const baseUrl = "https://img.weather.com.cn";
    const target = baseUrl + pathname.replace("/duanlin", "/mpfv3");

    const res = await fetch(target, {
      headers: {
        "User-Agent": iPhoneUserAgent,
        "Referer": "https://m.weathercn.com/",
        "Host": "weather-img.weathercn.com",
      },
    });

    const html = await res.text();
    const data = JSON.parse(html.substring(html.indexOf("{")));
    const imageUrl = baseUrl + "/mpfv3/";

    const imageList: string[] = [];
    const times: string[] = [];

    for (let i = data.value.length - 1; i >= 0; i--) {
      const item = data.value[i];
      const time = item.date[0].substring(0, 8);

      // 修复类型错误
      const reversedTimes = [...item.time].reverse();
      const reversedPaths = [...item.path].reverse();

      times.push(...reversedTimes.map(m => time + "" + m));
      imageList.push(...reversedPaths.map(v => getProxyImageUrl(url.origin,imageUrl + v)));
    }

    const stime = Number(data["stime"].replace(/\D/g, ""));
    const type: (1 | 2)[] = [];

    for (let s = 0; s < times.length; s++) {
      const time = Number(times[s].replace(/\D/g, ""));
      type.push(stime > time ? 1 : 2);
    }

    const dataParams = {
      rain_dl: {
        time: {
          obstime: data["obstime"],
          stime: data["stime"],
        },
        pics_location_range: {
          bottom_lat: 10.160640206803123,
          left_lon: 73.44630749105424,
          top_lat: 53.560640206803123,
          right_lon: 135.09,
        },
        result: {
          picture_url: imageList,
          forecast_time_list: times,
          type: type
        },
        pic_type: "precipitation",
      },
    };

    const response = Response.json(dataParams);

    // 缓存响应
    cacheResponse(response.clone(), cacheKey);

    return response;
  } catch (error) {
    console.error("Error processing duanlin data:", error);
    return new Response(`Error processing duanlin data: ${error.message}`, { status: 500 });
  }
}

// 处理图片代理
async function handleImageProxy(pathname: string, cacheKey: string): Promise<Response> {
  try {
    const encodedUrl = pathname.replace("/img/", "");
    let decodedUrl: string | null = null;
    // 1. 先尝试 decodeURIComponent
    try {
      const url = decodeURIComponent(encodedUrl);
      if (url.startsWith("http://") || url.startsWith("https://")) {
        decodedUrl = url;
      }
    } catch {
      // 忽略错误
    }

    // 2. 如果不是合法 URL，再尝试 Base64 解码
    if (!decodedUrl) {
      try {
        const base64Decoded = new TextDecoder().decode(decodeBase64(encodedUrl.substring(2)));
        if (
          base64Decoded.startsWith("http://") ||
          base64Decoded.startsWith("https://")
        ) {
          decodedUrl = base64Decoded;
        }
      } catch {
        // 仍无效
      }
    }

    if (!decodedUrl) {
      return new Response("Invalid image URL", { status: 400 });
    }
    decodedUrl = decodedUrl.split('$$')[0];
    console.log(decodedUrl)
    decodedUrl = urlPngToWebp(decodedUrl);
    const res = await fetch(decodedUrl, {
      headers: {
        "User-Agent": iPhoneUserAgent,
        "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
    });

    const contentType = res.headers.get("content-type") || "image/png";
    const imageBuffer = await res.arrayBuffer();

    const response = new Response(imageBuffer, {
      status: res.status,
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=86400", // 客户端缓存1天
      },
    });

    // 缓存响应
    cacheResponse(response.clone(), cacheKey);

    return response;
  } catch (error) {
    console.error("Error proxying image:", error);
    return new Response(`Error proxying image: ${error.message}`, { status: 500 });
  }
}

// 通用代理函数，带缓存
async function fetchProxyWithCache(req: Request, target: string, cacheKey: string): Promise<Response> {
  try {
    console.log("fetchProxy", req.method, req.url, target);
    const response = await fetchProxy(req, target);

    // 只缓存成功的GET请求
    if (req.method === "GET" && response.ok) {
      cacheResponse(response.clone(), cacheKey);
    }

    return response;
  } catch (error) {
    console.error("Proxy error:", error);
    return new Response(`Proxy error: ${error.message}`, { status: 502 });
  }
}

// 通用代理函数，保留请求方法和部分 headers
async function fetchProxy(req: Request, target: string): Promise<Response> {
  const reqHeaders = new Headers(req.headers);

  // 强制设置 User-Agent 可选
  reqHeaders.set("User-Agent", iPhoneUserAgent);

  // 设置 Host 为目标站点（有时可省略）
  reqHeaders.set("Host", new URL(target).host);

  // 移除部分不应传给目标服务器的头
  reqHeaders.delete("connection");
  reqHeaders.delete("content-length");
  reqHeaders.delete("accept-encoding");

  const fetchInit: RequestInit = {
    method: req.method,
    headers: reqHeaders,
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    fetchInit.body = await req.blob(); // 保留 POST/PUT body
  }

  const res = await fetch(target, fetchInit);
  return new Response(res.body, {
    status: res.status,
    headers: res.headers,
  });
}

// 将响应对象缓存起来
async function cacheResponse(response: Response, key: string): Promise<void> {
  try {
    const body = await response.arrayBuffer();
    const headers = new Headers(response.headers);

    // 添加缓存控制头
    headers.set("x-cache-date", new Date().toISOString());

    cache.set(key, {
      body,
      status: response.status,
      headers
    });
  } catch (error) {
    console.error("Error caching response:", error);
  }
}

// PNG转WebP的URL转换
function urlPngToWebp(url: string): string {
  if (url.includes("/webp/") && url.endsWith(".png"))
    return url.replace(/\.png$/, ".webp");
  return url;
}

/**
 *  获取图片代理地址
 * @param imageUrl
 */
const getProxyImageUrl = (pathName:string,imageUrl: string): string => {

  const bfStr = stringToBase64(imageUrl)
  const str = getRandomAZ2() + bfStr
  let url = `${pathName}/img/${str}`
  console.log(url)
  url = url.startsWith("/") ? url.substring(1) : url;
  return url
};

/**
 * 字符串转base64
 * @param str
 */
function stringToBase64(str:string): string {
  return encodeBase64(new TextEncoder().encode(str));
}

function getRandomAZ2() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  for (let i = 0; i < 2; i++) {
    const idx = Math.floor(Math.random() * chars.length);
    result += chars[idx];
  }
  return result;
}


console.log(`✅ Server running on http://localhost:${PORT}`);
serve(handleRequest, { port: PORT });
