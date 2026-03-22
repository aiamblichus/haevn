interface SidebarProps {
  activeView: string;
  setActiveView: (view: string) => void;
}

export const Sidebar = ({ activeView, setActiveView }: SidebarProps) => {
  const menuItems = [
    { id: "archive", label: "ARCHIVE", icon: "🌊" },
    { id: "gallery", label: "GALLERY", icon: "🖼️" },
    { id: "providers", label: "PROVIDERS", icon: "👁️" },
    { id: "settings", label: "SETTINGS", icon: "✨" },
    { id: "manifesto", label: "MANIFESTO", icon: "📜" },
  ];

  return (
    <aside
      className="w-64 bg-[hsl(var(--card))] border-r-2 border-[hsl(var(--border))] h-screen fixed left-0 top-0 flex flex-col"
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        boxShadow: "4px 0 0 0 rgba(0,0,0,0.2)",
      }}
    >
      <div className="p-6 border-b-2 border-[hsl(var(--border))]">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 flex items-center justify-center">
            <img
              src="../icons/haevn-logo.png"
              alt="HAEVN Logo"
              className="w-full h-full object-contain guardian-glow-logo"
            />
          </div>
          <div>
            <h1 className="text-lg font-bold text-[hsl(var(--foreground))] uppercase tracking-widest">
              HAEVN
            </h1>
            <p className="text-xs text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
              HAVEN FOR YOUR CHATS
            </p>
          </div>
        </div>
      </div>
      <nav className="flex-1 p-4 space-y-2">
        {menuItems.map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveView(item.id)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 text-xs font-bold transition-all duration-200 border-2 uppercase tracking-wider ${
              activeView === item.id
                ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-[hsl(var(--primary))] shadow-[0_0_8px_hsl(var(--primary)/0.5)]"
                : "bg-[hsl(var(--card))] text-[hsl(var(--muted-foreground))] border-[hsl(var(--border))] hover:border-[hsl(var(--primary))] hover:text-[hsl(var(--foreground))] hover:shadow-[0_0_4px_hsl(var(--primary)/0.3)]"
            }`}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              boxShadow:
                activeView === item.id
                  ? "0 0 0 1px rgba(0,0,0,0.3), 2px 2px 0 0 rgba(0,0,0,0.2)"
                  : "0 0 0 1px rgba(0,0,0,0.2)",
            }}
          >
            <span className="text-lg">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="p-4 border-t-2 border-[hsl(var(--border))]">
        <p
          className="text-xs text-[hsl(var(--muted-foreground))] text-center uppercase tracking-wider font-bold"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          GUARDIAN AT THRESHOLD
        </p>
      </div>
    </aside>
  );
};
