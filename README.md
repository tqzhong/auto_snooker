# Auto Snooker

AI 驱动的斯诺克对局模拟系统。两台 AI 球手基于当前台面形势、历史出杆记录，通过大模型 (Xiaomi MiMo) 做出出杆决策，再由物理引擎模拟完整的斯诺克对局，并以 2D 俯视角渲染台桌对阵过程。

## 功能特性

- **完整斯诺克规则**：遵循国际斯诺克规则，包括 15 红 + 6 彩球、红彩交替进攻、按顺序彩球阶段、犯规判定（主球落袋、错球首碰、无球接触、无库反弹等）
- **物理引擎**：球球碰撞、球库反弹、摩擦力衰减、落袋检测、旋转效果
- **AI 决策引擎**：基于 Xiaomi MiMo API（OpenAI 兼容格式），LLM 根据当前球形、双方得分、进攻/防守难度等上下文做出决策
- **2D Canvas 渲染**：俯视角斯诺克台桌，包含绿色台呢、棕色库边、6 个袋口、22 颗球的正确颜色和标注
- **计分牌**：实时显示双方得分、当前单杆、最高单杆、红球剩余等
- **出杆记录**：显示每次出杆的 AI 理由、进球/犯规详情

## 技术栈

- React 18 + TypeScript
- Vite 构建
- Canvas 2D 渲染
- Xiaomi MiMo API (OpenAI-compatible)

## 快速开始

```bash
# 安装依赖
npm install

# 配置 API Key
cp .env.example .env
# 编辑 .env 填入你的 Xiaomi MiMo API Key

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build
```

## 环境变量

在 `.env` 文件中配置：

```
VITE_AI_API_KEY=你的API密钥
VITE_AI_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
VITE_AI_MODEL=mimo-v2.5-pro
```

如果没有配置 API Key，系统将使用内置的规则引擎（基于最近目标球的简单策略）作为 fallback。

## 项目结构

```
src/
├── types/           # TypeScript 类型定义
├── engine/
│   ├── constants.ts # 台桌尺寸、物理常量
│   ├── physics.ts   # 球体运动、碰撞、落袋物理引擎
│   └── rules.ts     # 国际斯诺克规则引擎
├── ai/
│   └── llm-engine.ts # LLM 决策引擎 (Xiaomi MiMo)
├── renderer/
│   └── table-renderer.ts # Canvas 2D 台桌渲染器
├── components/
│   ├── GameTable.tsx   # 台桌 Canvas 组件
│   ├── Scoreboard.tsx  # 计分牌组件
│   └── ShotHistory.tsx # 出杆记录组件
└── App.tsx          # 主应用（游戏循环控制器）
```

## 斯诺克规则说明

1. **开球**：主球从 D 区出发，必须首先碰到红球
2. **红球阶段**：每次进球红球后必须选择一颗彩球进攻；进球彩球后彩球会被放回原位
3. **彩球阶段**：所有红球打完后，按 黄→绿→棕→蓝→粉→黑 顺序进球
4. **犯规**：主球落袋、错球首碰、无球接触等情况判罚 4-7 分给对手
5. **胜负**：所有球打完后得分高者获胜
