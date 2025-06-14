// deno run --allow-net main.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

const PORT = 8000;

// 特定 user-agent，用于模拟手机浏览器访问
const iPhoneUserAgent =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname + url.search;

  // 1. 获取并解析天气数据
  if (pathname === "/weathercn-data/") {
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

      return Response.json(DATA);
    } catch (err) {
      return new Response("Error fetching weather data: " + err.message, {
        status: 500,
      });
    }
  }

  // 2. 代理请求：/mpf/*
  if (pathname.startsWith("/mpf/")) {
    const target =
      "https://mpf.weather.com.cn" + pathname.replace("/mpf", "");
    return fetchProxy(req, target);
  }

  // 3. 特别处理 /imgjson/* 返回加工后的降水图数据
  if (pathname.startsWith("/duanlin/")) {
    const baseUrl = "https://img.weather.com.cn";
    const target = baseUrl + pathname.replace("/duanlin", "");
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
    const imageList = [];
    const times:  string[] = [];
    for (let i = data.value.length - 1; i >= 0; i--) {
      const item = data.value[i];
      const time = item.date[0].substring(0, 8);
      console.log(time,JSON.stringify(item.date))
      console.log(JSON.stringify(item.time))
      times.push(...item.time.reverse().map(m => String(time) +""+ String(m) ));
      imageList.push(...item.path.reverse().map((v) => imageUrl + v));
    }
    console.log("[Image List]", JSON.stringify(times));
    const stime = Number(data["stime"].replace(/\D/g, ""));
    const type = []
    // for (let s in times){
    //   const time = Number(times[s].replace(/\D/g, ""));
    //   type.push(stime>time?1:2)
    // }
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
          type:type
        },
        pic_type: "precipitation",
      },
    };
    return Response.json(dataParams);
  }

  // 4. 小米代理
  if (pathname.startsWith("/wtr-v3/")) {
    const target =
      "https://weatherapi.market.xiaomi.com/wtr-v3" +
      pathname.replace("/wtr-v3", "");
    return fetchProxy(req, target);
  }


  // 5. 图片代理 /imgproxy/*
  if (pathname.startsWith("/img/")) {
    // 获取真实图片 URL，注意解码
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

    decodedUrl = urlPngToWebp(decodedUrl)
    const res = await fetch(decodedUrl, {
      headers: {
        "User-Agent": iPhoneUserAgent,
        "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
    });

    const contentType = res.headers.get("content-type") || "image/png";
    const imageBuffer = await res.arrayBuffer();

    return new Response(imageBuffer, {
      status: res.status,
      headers: {
        "content-type": contentType,
      },
    });
  }

  //  6. d3代理
  if (pathname.startsWith("/d3/")) {
    const target =
        "https://d3.weather.com.cn" +
        pathname.replace("/d3", "");
    return fetchProxy(req, target);
  }

  //  6. d4代理
  if (pathname.startsWith("/d4/")) {
    const target =
        "https://d4.weather.com.cn" +
        pathname.replace("/d4", "");
    return fetchProxy(req, target);
  }

  return new Response("Not Found", { status: 404 });
}

// 通用代理函数，保留请求方法和部分 headers
async function fetchProxy(req: Request, target: string): Promise<Response> {
  console.log("fetchProxy", req.method, req.url, target);
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
function urlPngToWebp(url: string) {
  if (url.includes("/webp/") && url.endsWith(".png"))
    return url.replace(/\.png$/, ".webp");
  return url;
}

console.log(`✅ Server running on http://localhost:${PORT}`);
serve(handleRequest, { port: PORT });
