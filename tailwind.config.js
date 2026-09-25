/** @type {import('tailwindcss').Config} */

// Theme colors are CSS variables (RGB channels) defined per theme in
// src/index.css, so one set of class names serves both light and dark mode.
const themed = (name, shades) =>
  Object.fromEntries(
    shades.map((shade) => [shade, `rgb(var(--${name}-${shade}) / <alpha-value>)`]),
  );
const SCALE = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Clay accent.
        primary: themed('primary', SCALE),
        // Warm neutrals, ordered by role rather than lightness: 950 is the
        // page background, 800 a raised surface, 600-700 borders, 400-500
        // secondary text, and 50 the strongest text — in both themes.
        ink: themed('ink', SCALE),
        danger: 'rgb(var(--danger) / <alpha-value>)',
        success: 'rgb(var(--success) / <alpha-value>)',
        warning: 'rgb(var(--warning) / <alpha-value>)',
      },
    },
  },
  plugins: [],
}
