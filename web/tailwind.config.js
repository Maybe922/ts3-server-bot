import { heroui } from "@heroui/react";

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "./node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  plugins: [
    heroui({
      themes: {
        dark: {
          colors: {
            primary: { DEFAULT: "#4a9eff", foreground: "#ffffff" },
          },
        },
        light: {
          colors: {
            primary: { DEFAULT: "#2f7fe0", foreground: "#ffffff" },
          },
        },
      },
    }),
  ],
};
