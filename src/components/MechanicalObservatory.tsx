import { useId } from 'react';
import './MechanicalObservatory.css';

function cogPath(cx: number, cy: number, radius: number, teeth: number) {
  const points: string[] = [];
  for (let tooth = 0; tooth < teeth; tooth++) {
    for (let corner = 0; corner < 4; corner++) {
      const angle = ((tooth + corner / 4) / teeth) * Math.PI * 2;
      const length = radius * (corner === 1 || corner === 2 ? 1 : 0.87);
      points.push(`${cx + Math.cos(angle) * length},${cy + Math.sin(angle) * length}`);
    }
  }
  return `M${points.join('L')}Z`;
}

/** A decorative instrument: dial positions do not represent market data. */
export default function MechanicalObservatory() {
  const id = useId().replace(/:/g, '');
  const paint = (name: string) => `url(#${id}-${name})`;
  const rivet = (x: number, y: number, key?: string) => (
    <g key={key} transform={`translate(${x} ${y})`}>
      <circle r="4.1" fill={paint('brass')} stroke="#171b17" strokeWidth="1.3" />
      <path d="M-1.8 1.8L1.8-1.8" stroke="#403525" strokeWidth="1.2" />
    </g>
  );
  const gear = (x: number, y: number, r: number, teeth: number, reverse = false) => (
    <g className={`observatory-gear${reverse ? ' observatory-gear-reverse' : ''}`} style={{ transformOrigin: `${x}px ${y}px` }}>
      <path d={cogPath(x, y, r, teeth)} fill={paint('copper')} stroke="#281f19" strokeWidth="1.5" />
      <circle cx={x} cy={y} r={r * 0.61} fill="#172321" stroke="#bc9056" strokeWidth="2.5" />
      {[0, 60, 120].map(angle => <path key={angle} d={`M${x - r * 0.62} ${y}H${x + r * 0.62}`} transform={`rotate(${angle} ${x} ${y})`} stroke="#a57644" strokeWidth={r * 0.18} />)}
      <circle cx={x} cy={y} r={r * 0.2} fill={paint('brass')} stroke="#3d3020" strokeWidth="2" />
      <circle cx={x} cy={y} r={r * 0.075} fill="#172321" />
    </g>
  );
  const dial = (x: number, label: string, angle: number) => (
    <g transform={`translate(${x} 244)`}>
      <circle r="109" fill="#101714" stroke="#332b20" strokeWidth="3" />
      <circle r="105" fill={paint('brass')} stroke="#d5b277" strokeWidth="1" />
      <circle r="99" fill="none" stroke="#514329" strokeWidth="1.5" />
      <circle r="92" fill={paint('face')} stroke="#2e362b" strokeWidth="3" />
      <circle r="87" fill="none" stroke="#b6935a" strokeWidth="0.8" />
      <circle r="58" fill="none" stroke="#bda477" strokeWidth="0.7" opacity=".55" />
      {Array.from({ length: 60 }, (_, index) => (
        <path key={index} d={`M0 -82V-${index % 5 === 0 ? 68 : 76}`} transform={`rotate(${index * 6})`} stroke="#43503e" strokeWidth={index % 5 === 0 ? 1.8 : 0.8} />
      ))}
      {[0, 90, 180, 270].map(degrees => <circle key={degrees} cx="0" cy="-63" r="1.5" fill="#6b593a" transform={`rotate(${degrees})`} />)}
      <text y="-36" textAnchor="middle" className="observatory-dial-label">{label}</text>
      <path d="M-28 36H28M-18 40H18" stroke="#9d8c66" strokeWidth=".65" />
      <text y="54" textAnchor="middle" className="observatory-dial-caption">OBSERVATION</text>
      <g className="observatory-needle" style={{ '--needle-angle': `${angle}deg` } as React.CSSProperties}>
        <path d="M0-66L4 0L2 21L-2 21L-4 0Z" fill="#344b3f" stroke="#172d23" strokeWidth=".7" />
        <path d="M0-63V17" stroke="#d2b67d" strokeWidth=".75" />
      </g>
      <circle r="9" fill={paint('brass')} stroke="#3a402e" strokeWidth="1.5" />
      <circle r="3.5" fill="#344b3f" />
      <path d="M-77-45A89 89 0 0 1 51-74" fill="none" stroke="#fff9d9" strokeWidth="7" opacity=".13" strokeLinecap="round" />
      {[45, 135, 225, 315].map(degrees => {
        const a = degrees * Math.PI / 180;
        return rivet(Math.cos(a) * 99, Math.sin(a) * 99, String(degrees));
      })}
    </g>
  );

  return (
    <div className="mechanical-observatory" aria-hidden="true">
      <svg viewBox="0 0 640 485" role="presentation" focusable="false">
        <defs>
          <linearGradient id={`${id}-brass`} x1="0" y1="0" x2=".75" y2="1">
            <stop stopColor="#ddbd7e" /><stop offset=".22" stopColor="#a97b40" /><stop offset=".48" stopColor="#edce90" /><stop offset=".63" stopColor="#9f703c" /><stop offset="1" stopColor="#d1a86a" />
          </linearGradient>
          <linearGradient id={`${id}-copper`} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#d09b67" /><stop offset=".36" stopColor="#926039" /><stop offset=".62" stopColor="#bd8654" /><stop offset="1" stopColor="#553d2a" />
          </linearGradient>
          <radialGradient id={`${id}-face`} cx=".42" cy=".35" r=".7">
            <stop stopColor="#f1e4c3" /><stop offset=".76" stopColor="#ded0aa" /><stop offset="1" stopColor="#bba67b" />
          </radialGradient>
          <linearGradient id={`${id}-enamel`} x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#30463d" /><stop offset=".5" stopColor="#182b25" /><stop offset="1" stopColor="#101d18" />
          </linearGradient>
          <linearGradient id={`${id}-pipe`} x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#664628" /><stop offset=".4" stopColor="#d0a065" /><stop offset=".56" stopColor="#e0b979" /><stop offset="1" stopColor="#684629" />
          </linearGradient>
          <radialGradient id={`${id}-glass`} cx=".35" cy=".25" r=".85">
            <stop stopColor="#acbd9b" stopOpacity=".6" /><stop offset=".4" stopColor="#294b3b" /><stop offset="1" stopColor="#14261e" />
          </radialGradient>
          <filter id={`${id}-shadow`} x="-30%" y="-30%" width="160%" height="180%">
            <feDropShadow dx="0" dy="13" stdDeviation="13" floodColor="#000" floodOpacity=".4" />
          </filter>
        </defs>

        <g className="observatory-drafting" fill="none" stroke="currentColor" strokeWidth=".75" opacity=".18">
          <circle cx="320" cy="244" r="210" strokeDasharray="2 7" />
          <path d="M20 244H620M320 18V470M88 28v28m-14-14h28M552 428v28m-14-14h28" />
          <path d="M54 155V354M47 155H61M47 354H61M582 155V354M575 155H589M102 414H535M102 408V420M535 408V420" />
        </g>
        <g filter={paint('shadow')}>
          <path d="M153 152V117Q153 87 186 87H453Q486 87 486 120V151" fill="none" stroke="#1b211a" strokeWidth="17" />
          <path d="M153 152V117Q153 87 186 87H453Q486 87 486 120V151" fill="none" stroke={paint('pipe')} strokeWidth="12" />
          <path d="M188 84H451" fill="none" stroke="#e2ba7a" strokeWidth="1.5" opacity=".6" />
          {[203, 426].map(x => <g key={x}><rect x={x} y="77" width="15" height="21" rx="2" fill={paint('copper')} stroke="#403321" /><path d={`M${x + 4} 79V96M${x + 11} 79V96`} stroke="#d2ae70" strokeWidth="1" /></g>)}
          <path d="M125 309V361Q125 380 147 380H495Q517 380 517 356V309" fill="none" stroke="#1c211b" strokeWidth="19" />
          <path d="M125 309V361Q125 380 147 380H495Q517 380 517 356V309" fill="none" stroke={paint('pipe')} strokeWidth="13" />

          {gear(243, 145, 49, 16)}
          {gear(355, 135, 30, 12, true)}
          {gear(418, 136, 44, 16)}
          {gear(255, 356, 37, 14, true)}
          {gear(400, 355, 46, 16)}

          <path d="M151 175Q150 158 170 153L290 129H350L470 153Q490 158 489 175L498 326Q500 345 481 350L353 373H287L159 350Q140 345 142 326Z" fill={paint('enamel')} stroke={paint('brass')} strokeWidth="3" />
          <path d="M162 179L297 143H343L478 179M160 333L295 359H345L480 333" fill="none" stroke="#8a754b" strokeWidth=".8" opacity=".7" />
          {rivet(310, 149)}{rivet(330, 149)}{rivet(310, 353)}{rivet(330, 353)}
          {dial(201, 'POOL A', -46)}
          {dial(439, 'POOL B', 39)}

          <g transform="translate(320 244)">
            <path d="M-24-50L24-50L31-42V42L24 50H-24L-31 42V-42Z" fill={paint('brass')} stroke="#29271d" strokeWidth="2" />
            <rect x="-22" y="-42" width="44" height="84" rx="4" fill="#14261f" stroke="#987344" />
            <path d="M-11-25H-5C13-25 13-2-5-2H-11Z M-3 3H3C21 3 21 26 3 26H-3Z" fill="none" stroke="#d1ad70" strokeWidth="3.2" />
            <circle cx="-13" cy="30" r="2" fill="#e4c187" />
            <path d="M-16-35H16M-16 35H16" stroke="#806840" strokeWidth=".6" />
          </g>

          <g transform="translate(320 70)">
            <path d="M-92-13H92L101 0L92 13H-92L-101 0Z" fill={paint('brass')} stroke="#28251c" strokeWidth="1.5" />
            <rect x="-85" y="-9" width="170" height="18" rx="1" fill="#25372c" stroke="#856b44" strokeWidth=".6" />
            <text y="3.2" textAnchor="middle" className="observatory-plaque-title">PRICE OBSERVATORY</text>
            {rivet(-93, 0)}{rivet(93, 0)}
          </g>

          <g transform="translate(320 391)">
            <path d="M-121-17H121L127-11V14L121 20H-121L-127 14V-11Z" fill={paint('brass')} stroke="#27231b" strokeWidth="1.5" />
            <rect x="-110" y="-10" width="220" height="23" rx="1" fill={paint('enamel')} stroke="#e0bd7d" strokeWidth=".6" />
            <text y="4.5" textAnchor="middle" className="observatory-plaque-caption">COMPARE · INSPECT · VERIFY</text>
            {rivet(-118, 1)}{rivet(118, 1)}
          </g>
          <g transform="translate(83 244)">
            <rect x="-15" y="-22" width="18" height="44" rx="2" fill={paint('copper')} stroke="#423622" />
            {[-15, -8, -1, 6, 13].map(y => <path key={y} d={`M-13 ${y}H1`} stroke="#dfb87a" strokeWidth="1.3" />)}
          </g>
          <g transform="translate(557 244)">
            <rect x="-3" y="-22" width="18" height="44" rx="2" fill={paint('copper')} stroke="#423622" />
            {[-15, -8, -1, 6, 13].map(y => <path key={y} d={`M-1 ${y}H13`} stroke="#dfb87a" strokeWidth="1.3" />)}
          </g>
        </g>
        <text x="320" y="450" textAnchor="middle" className="observatory-footnote">TWO PERSPECTIVES. ONE CLEARER PICTURE.</text>
      </svg>
    </div>
  );
}
