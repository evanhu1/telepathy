import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["Space Grotesk", "Avenir Next", "Segoe UI", "sans-serif"],
        sans: ["IBM Plex Sans", "Avenir Next", "Segoe UI", "sans-serif"],
      },
      colors: {
        ink: {
          50: "#f5f3ff",
          200: "#d7c9ff",
          400: "#9b82ff",
          600: "#5a3bdb",
          800: "#2d176b",
          900: "#160a35",
        },
        ember: {
          300: "#ffb894",
          500: "#ff7b44",
          700: "#cb4d1f",
        },
        graphite: {
          100: "#f3f5f8",
          200: "#d8dee9",
          400: "#7f8796",
          700: "#29303f",
          900: "#141821",
        },
      },
      boxShadow: {
        glow: "0 12px 40px rgba(90, 59, 219, 0.25)",
      },
    },
  },
  plugins: [],
} satisfies Config;
