import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          'deep-saffron': '#D97706',
          ink: '#1A1530',
          ivory: '#FAF7F0',
          'rose-gold': '#C97B63',
          twilight: '#3B3169',
          'gold-accent': '#E8C547',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'serif'],
        body: ['var(--font-body)', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
