import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 简单的深色主题，沿用 Claude 的橙色调
        accent: {
          DEFAULT: "#d97757",
          hover: "#c56544",
        },
      },
    },
  },
  plugins: [
    require("@tailwindcss/typography"),
  ],
} satisfies Config;
