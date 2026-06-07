"use client";

// 启动页：全屏暗底，左品牌字右蛛网图。点击 CTA 后回调 onEnter 消失。

export default function SplashScreen({ onEnter }: { onEnter: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex"
      style={{
        background: "#111110",
        backgroundImage: "url('/spiderweb.png')",
        backgroundSize: "cover",
        backgroundPosition: "right center",
        backgroundRepeat: "no-repeat",
        color: "#fff",
      }}
    >
      <div className="flex flex-1 flex-col justify-center px-20 lg:px-36">
        <h1 className="font-serif text-[clamp(64px,10vw,112px)] font-bold italic leading-none tracking-tight text-white">
          SceneWeaver
        </h1>
        <p className="mt-5 max-w-md text-lg leading-relaxed text-white/55 lg:text-xl">
          把小说，织成可打磨的剧本。
        </p>
        <button
          onClick={onEnter}
          className="mt-10 inline-flex w-fit items-center gap-1.5 rounded border px-3 py-1.5 text-sm font-medium tracking-wide text-[#C0974A] transition-colors duration-200 hover:bg-[#C0974A] hover:text-[#111]"
          style={{ borderColor: "#C0974A" }}
        >
          进入工作台
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </button>
      </div>
    </div>
  );
}
