import { useStatus } from "../../context/StatusContext";

interface HeaderProps {
  activeView: string;
}

export const Header = ({ activeView }: HeaderProps) => {
  const { text, color } = useStatus();
  const titles: Record<string, string> = {
    archive: "ARCHIVE",
    manifesto: "MANIFESTO",
    providers: "PROVIDERS",
    settings: "SETTINGS",
  };
  const icons: Record<string, string> = {
    archive: "🌊",
    manifesto: "📜",
    providers: "👁️",
    settings: "✨",
  };
  return (
    <header
      className="h-16 border-b-2 border-[hsl(var(--border))] bg-[hsl(var(--card))] backdrop-blur-sm flex items-center justify-between px-6 fixed top-0 left-64 right-0 z-10"
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        boxShadow: "0 2px 0 0 rgba(0,0,0,0.2)",
      }}
    >
      <div className="flex items-center gap-3">
        <span className="text-2xl">{icons[activeView] || "🌊"}</span>
        <h2 className="text-base font-bold text-[hsl(var(--foreground))] uppercase tracking-widest">
          {titles[activeView] || "ARCHIVE"}
        </h2>
      </div>
      <div
        className={`text-xs flex items-center gap-2 font-bold uppercase tracking-wider ${color}`}
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
        {text && (
          <>
            <div
              className="w-2 h-2 border-2 border-current"
              style={{ boxShadow: "0 0 4px currentColor" }}
            ></div>
            <span>{text.toUpperCase()}</span>
          </>
        )}
      </div>
    </header>
  );
};
