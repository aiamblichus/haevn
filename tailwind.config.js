/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./src/**/*.{html,js,ts,tsx}"],
  safelist: [
    // Layout & positioning
    "inset-0",
    "m-4",
    "p-6",
    "p-5",
    "p-3",
    "px-5",
    "px-6",
    "py-4",
    "pb-5",
    "pt-6",
    "mt-1",
    "mt-4",
    "mb-2",
    "mb-3",
    "mb-4",
    "-top-1",
    "-right-1",
    "ml-auto",
    "gap-1",
    "gap-2",
    "gap-3",
    "gap-4",
    "space-y-2",
    "space-y-4",
    "space-y-6",
    "relative",
    "absolute",
    "right-2",
    "top-1/2",
    "-translate-y-1/2",
    "pr-10",

    // Sizing
    "w-2",
    "w-3",
    "w-4",
    "w-5",
    "w-6",
    "w-8",
    "w-11",
    "h-2",
    "h-3",
    "h-4",
    "h-5",
    "h-6",
    "h-8",
    "h-11",

    // Background & border - HAEVN themed
    "bg-white/95",
    "bg-white/90",
    "bg-white/80",
    "bg-white/70",
    "bg-white/50",
    "bg-white/30",
    "bg-white/20",
    "bg-gray-50",
    "bg-gray-100",
    "bg-gray-200",
    "bg-gray-50/80",
    "bg-haevn-navy/95",
    "bg-haevn-navy/80",
    "bg-haevn-navy/50",
    "bg-haevn-teal/20",
    "bg-haevn-teal/30",
    "bg-haevn-gold/20",
    "bg-green-400",
    "bg-amber-400",
    "bg-orange-100",
    "backdrop-blur-xl",
    "backdrop-blur-sm",
    "rounded-xl",
    "rounded-2xl",
    "rounded-lg",
    "rounded-md",
    "rounded-full",
    "border-white/20",
    "border-white/40",
    "border-gray-100",
    "border-gray-200",
    "border-gray-300",
    "border-haevn-teal/30",
    "border-haevn-gold/30",
    "border-2",
    "border-t",
    "border-b",

    // Shadows
    "shadow-lg",
    "shadow-xl",
    "shadow-2xl",
    "shadow-md",
    "shadow-inner",
    "shadow-black/5",
    "shadow-black/10",
    "shadow-black/20",
    "shadow-haevn-teal/25",
    "shadow-haevn-teal/30",
    "shadow-haevn-gold/25",
    "shadow-indigo-500/25",
    "shadow-indigo-500/30",
    "shadow-indigo-500/40",

    // Text & typography
    "text-xs",
    "text-sm",
    "text-base",
    "text-xl",
    "text-white",
    "text-gray-600",
    "text-gray-700",
    "text-gray-800",
    "text-gray-900",
    "text-haevn-teal",
    "text-haevn-gold",
    "text-haevn-purple",
    "text-indigo-600",
    "text-orange-700",
    "text-green-600",
    "font-sans",
    "font-mono",
    "font-medium",
    "font-semibold",
    "font-bold",
    "tracking-tight",
    "tracking-wide",
    "leading-relaxed",

    // Hover states
    "hover:bg-white",
    "hover:bg-white/50",
    "hover:bg-gray-200",
    "hover:bg-haevn-teal/30",
    "hover:bg-haevn-gold/30",
    "hover:text-gray-900",
    "hover:border-gray-300",
    "hover:shadow-xl",
    "hover:shadow-black/10",
    "hover:shadow-haevn-teal/40",
    "group-hover:bg-white/30",
    "group-hover:bg-gray-200",
    "group-hover:text-gray-900",

    // Focus states
    "focus:ring-haevn-teal",
    "focus:ring-indigo-500",
    "focus:ring-2",
    "focus:outline-none",
    "focus:border-transparent",

    // Animations & transforms
    "animate-pulse",
    "animate-gradient-xy",
    "animate-shimmer",
    "hover:scale-[1.02]",
    "active:scale-[0.98]",
    "hover:rotate-0",
    "guardian-glow",
    "guardian-glow-logo",
    "lighthouse-glow",

    // Disabled states
    "disabled:opacity-50",
    "disabled:cursor-not-allowed",
  ],
  theme: {
    extend: {
      colors: {
        // HAEVN Brand Colors (from visual identity)
        haevn: {
          navy: "#1E3A5F", // Deep harbor blue (backgrounds)
          "navy-dark": "#2C3E50", // Darker navy (depth)
          "navy-light": "#34495E", // Lighter navy
          teal: "#00CED1", // Guardian eye cyan (primary)
          "teal-light": "#40E0D0", // Lighter teal
          "teal-bright": "#4FD1C5", // Brightest teal
          aqua: "#20B2AA", // Calm water
          gold: "#D4AF37", // Lighthouse & sacred geometry (secondary)
          "gold-light": "#FFD700", // Bright gold
          "gold-dark": "#B8960C", // Deep gold
          purple: "#DA70D6", // Aurora & threshold (accent)
          "purple-light": "#B57EDC", // Lighter purple
          "purple-deep": "#9F7AEA", // Deep purple
          magenta: "#FF00FF", // Glitch accent
          orange: "#FF8C42", // Window warmth
          "orange-light": "#FFA726", // Lighter orange
          grey: "#2D3748", // Dark grey backgrounds
          "grey-darker": "#1A202C", // Darkest grey
        },
        // Shadcn/UI theme tokens
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      backgroundImage: {
        "gradient-haevn": "linear-gradient(135deg, #1E3A5F 0%, #2C3E50 50%, #1A202C 100%)",
        "gradient-aurora": "linear-gradient(135deg, #00CED1 0%, #DA70D6 50%, #4FD1C5 100%)",
        "gradient-lighthouse": "linear-gradient(135deg, #D4AF37 0%, #FFD700 100%)",
      },
      boxShadow: {
        "haevn-glow": "0 0 20px rgba(0, 206, 209, 0.3)",
        "gold-glow": "0 0 20px rgba(212, 175, 55, 0.3)",
        "purple-glow": "0 0 20px rgba(218, 112, 214, 0.3)",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        shimmer: "shimmer 3s linear infinite",
      },
    },
  },
  plugins: [],
};
