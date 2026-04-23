# Image / Spreadsheet / PDF 生成功能 — 安装指南

> 本文档是这一轮新增的三个生成类工具的配置说明。总结在中文，代码/命令/参数保持英文。

---

## 1. Spreadsheet (`xlsx`) — 开箱即用

- 依赖：`exceljs`（已加入 `package.json`）。
- 重启 Melo 前先执行一次：

  ```bash
  cd "Melo Desktop Project"
  npm install
  ```

- 调用示例（LLM 会自动发 `tool_call`，手测可用 `/tool` 命令）：

  ```json
  {
    "tool": "xlsx",
    "args": {
      "sheets": [{
        "name": "Sales",
        "columns": [
          { "header": "Month",   "key": "month",   "width": 12 },
          { "header": "Revenue", "key": "revenue", "width": 14, "numFmt": "\"$\"#,##0.00" }
        ],
        "rows": [
          { "month": "Jan", "revenue": 12500 },
          { "month": "Feb", "revenue": 14200 }
        ]
      }]
    }
  }
  ```

- 输出：`<workspace>/generated/xlsx-*.xlsx` + 签名 URL，消息中会直接出现下载链接。

---

## 2. PDF `action: "structured"` — 开箱即用

- 依赖：`pdfkit`（已加入 `package.json`）。
- 不再需要 Playwright / Chromium —— 纯 Node，离线可用。
- 调用示例：

  ```json
  {
    "tool": "pdf",
    "args": {
      "action": "structured",
      "title": "Q1 Report",
      "sections": [
        { "type": "heading", "level": 1, "text": "Q1 Sales" },
        { "type": "paragraph", "text": "Summary of Q1 performance." },
        {
          "type": "table",
          "columns": [{ "header": "Region" }, { "header": "Revenue" }],
          "rows": [["North", "$125k"], ["South", "$98k"]]
        },
        { "type": "rule" },
        { "type": "list", "ordered": true, "items": ["Close Q2", "Hire analyst"] }
      ]
    }
  }
  ```

- 已支持的 section 类型：`heading` / `paragraph` / `list` / `table` / `image` / `code` / `rule` / `spacer` / `pageBreak`。
- 老的 `action: "write"`（Playwright）保留作为 HTML → PDF 的高保真回退方案。

---

## 3. Image `engine: "sdcpp"` — 需要一次性配置

默认 `engine: "auto"` 会优先走本地 sd.cpp，失败或未安装则回退到 MiniMax。

### 3.1 下载编译 stable-diffusion.cpp

```bash
# 路径仅为示例 —— 放哪都行，之后通过 sdcppBinary 指向即可
cd ~/Tools
git clone https://github.com/leejet/stable-diffusion.cpp
cd stable-diffusion.cpp
git submodule update --init --recursive

# Apple Silicon：启用 Metal
cmake -B build -DSD_METAL=ON
cmake --build build -j

# 产物：build/bin/sd
```

### 3.2 下载 SDXL base 1.0 权重

```bash
mkdir -p "<MeloProject>/.tmp/melo-home-user/sd-models"
cd "<MeloProject>/.tmp/melo-home-user/sd-models"
# SDXL base 1.0, safetensors, ~6.5GB
curl -L -o sd_xl_base_1.0.safetensors \
  https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors
```

### 3.3 把二进制路径告诉 Melo（两种方式任选一种）

- **方式 A — 环境变量**：启动前 `export SDCPP_BINARY=$HOME/Tools/stable-diffusion.cpp/build/bin/sd`
- **方式 B — Melo 配置**：在设置里加入 `sdcppBinary`、`sdcppModelPath`（也可以只设 binary，模型走默认路径）。

### 3.4 调用示例

```json
{
  "tool": "image",
  "args": {
    "action": "generate",
    "engine": "sdcpp",
    "prompt": "a winter cat sitting by a window, photorealistic, soft light",
    "negativePrompt": "blur, low-res, watermark",
    "width": 1024,
    "height": 1024,
    "steps": 30,
    "cfgScale": 7.5,
    "seed": 42
  }
}
```

- Apple Silicon (M1/M2/M3/M4) 上 1024×1024 单张 ~ 15–25 秒。
- 省略 `engine` 或写 `"auto"` 时，Melo 会自己挑：本地存在 sd.cpp + 模型就走本地；否则回退到 MiniMax（需要 `minimaxApiKey`）。
- 强制走云端：`engine: "minimax"`。

---

## 4. 回归检查

```bash
cd "Melo Desktop Project"
npm install         # 装新的 exceljs / pdfkit
node scripts/check-syntax.js       # 等价于 npm run build
npm test                           # red/green 检查
```

注：`imageTool.output.test.js`、`pdfTool.output.test.js` 已存在的旧测试都是走 workspace-URL 路径的，不会因为新增 `engine` 入参而 break。新 `structured` 和 `xlsxTool` 的单测后续再补。
