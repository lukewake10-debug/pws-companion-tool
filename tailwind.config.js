/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        deck: {
          950: "#090b0f",
          900: "#11151c",
          850: "#161b23",
          800: "#1d2430",
          700: "#2a3342",
        },
        roh: {
          gold: "#d7b56d",
          red: "#b84040",
          cyan: "#62c5d8",
        },
      },
      boxShadow: {
        deck: "0 18px 48px rgba(0, 0, 0, 0.32)",
      },
    },
  },
  plugins: [],
};
