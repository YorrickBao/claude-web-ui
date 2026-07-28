import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import App from "@/App";
// 字体本地化打包进 dist（@fontsource），不 runtime 从外网加载。
// Inter Variable 作 UI/正文主字；JetBrains Mono 作代码块/工具名/数据等等宽用字。
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@/index.css";
// Streamdown 的逐词淡入动画样式（[data-sd-animate]）。可选但属于 streamdown 体验的一部分。
import "streamdown/styles.css";
// side-effect import：模块加载即触发 profile 列表预取，与会话 meta fetch 并行，
// 消除对话输入框 profile Select 在刷新时闪现 UUID 的串行竞态。
import "@/lib/profilesStore";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
        <App />
      </ThemeProvider>
    </HashRouter>
  </StrictMode>,
);
