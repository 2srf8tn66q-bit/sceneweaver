// 蛛网小 logo，品牌标识。page.tsx 和 Workbench.tsx 共用。

export default function WebMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#C0974A" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true" className={className}>
      {[0,45,90,135,180,225,270,315].map((a,i) => { const r = a*Math.PI/180; return <line key={i} x1="12" y1="12" x2={12+11*Math.cos(r)} y2={12+11*Math.sin(r)} opacity="0.85" />; })}
      {[10.2,7.2,4.4].map((rad,i) => { const pts = [0,45,90,135,180,225,270,315].map(a => { const r = a*Math.PI/180; return `${(12+rad*Math.cos(r)).toFixed(2)},${(12+rad*Math.sin(r)).toFixed(2)}`; }).join(" "); return <polygon key={i} points={pts} opacity={0.55+i*0.12} />; })}
      <circle cx="12" cy="12" r="1.4" fill="#C0974A" stroke="none" />
    </svg>
  );
}
