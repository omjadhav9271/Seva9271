import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        // Seva brand colors
        saffron: {
          DEFAULT: '#FF9933',
          light: '#ffb366',
          dark: '#e8872e',
          50: '#fff7ed',
          100: '#ffedd5',
          500: '#FF9933',
          600: '#e8872e',
          700: '#cc6600',
        },
        'india-green': {
          DEFAULT: '#138808',
          light: '#1aab0a',
          dark: '#0d6006',
          50: '#f0fdf0',
          100: '#dcfce7',
          500: '#138808',
          600: '#0d6006',
          700: '#094d04',
        },
        navy: {
          DEFAULT: '#054187',
          light: '#0a5fb8',
          dark: '#032a58',
        },
        'seva-bg': '#0d0d0d',
        'seva-card': '#161616',
        'seva-card-2': '#1e1e1e',
        'seva-border': '#2a2a2a',
        'seva-muted': '#6b7280',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'seva-gradient': 'linear-gradient(135deg, #FF9933 0%, #138808 100%)',
        'seva-hero': 'radial-gradient(ellipse at top left, rgba(255,153,51,0.15) 0%, transparent 50%), radial-gradient(ellipse at bottom right, rgba(19,136,8,0.1) 0%, transparent 50%)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
export default config;
