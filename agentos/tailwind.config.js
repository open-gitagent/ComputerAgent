/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Warm dark "retro terminal" palette (sepia-tinted near-black).
        ink: {
          900: "#0e0b07",
          800: "#17120c",
          700: "#221a11",
          600: "#2f2417",
          500: "#3e3020",
        },
        // CRT-green accent (the glowing monitor).
        accent: {
          DEFAULT: "#16a34a",
          soft: "#4ade80",
        },
        sand: "#d9c7a3",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
