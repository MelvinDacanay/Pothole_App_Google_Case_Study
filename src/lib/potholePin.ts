// Trusted, bundled artwork from the supplied patchup-pothole-pin.svg.
const POTHOLE_PIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="30" viewBox="0 0 24 30">
  <title>PatchUp pothole marker</title>
  <path d="m1.1 15.4 2.7-1.7-.6-1.9 3.8-.8 1.7-2.2 3.3.6 2.9-2.2 1.9 2.7 3.8 1.1-.4 2.3 2.7 2.8-2.5 1.7.4 2-3.4.8-2.2 2-3.7-.5-2.6 1-1.7-2.5-3.8-.8.5-1.7Z"
        fill="#8f7779" stroke="#fff3de" stroke-width="1.4" stroke-linejoin="round" paint-order="stroke"/>
  <path d="m3.9 13.7 2.7 1m5.3-5.3.6 2.8m7.7 1.1-2.8 1.5m2.9 3-2.4-.6m-9 5.9.5-2.4m-5.5-2.6 2.7-.7"
        fill="none" stroke="#49322f" stroke-width=".75" stroke-linecap="round"/>
  <path d="m4.2 15.3 2.4-.9 1.6-1.9 3.3.3 2.8-1.6 2 1.6 3 .9-.4 1.6 1.1 1.3-2.5 1.3-1.2 1.7-3.1-.2-2 .9-2-1.1-2.8.2-.7-1.9Z"
        fill="#efbf99" stroke="#44302e" stroke-width="1" stroke-linejoin="round"/>
  <path d="m6 15.6 2-.4 1.2-1.1 2.6.1 2.4-1.2 1.5 1 1.9.6-.5 1.2.9.7-2 .9-.8 1.1-2.2-.2-1.7.8-1.6-.9-2.1.2-.4-1.5Z" fill="#50332f"/>
  <path d="m8.2 17.1 1.7-.7 1.8.1 1.8-1 1.7.2 1.9.7-1.4.7-.6 1.2-2.2-.2-1.6.8-1.6-.9-1.4.1Z" fill="#32a5d4"/>
  <path d="m9.2 14.1 1.4.1-.6 1.9-1.1.4zm5.1-.9 1.4.8-.4 1.7-1.4-.2z" fill="#ce7943"/>
  <path d="m11.7 17.7 1.3-.5 1.1.1" fill="none" stroke="#a1dced" stroke-width=".55" stroke-linecap="round"/>
</svg>`;

export function createPotholePin(label: string, selected = false): HTMLDivElement {
  // AdvancedMarkerElement owns its content node: create a fresh one per marker.
  const element = document.createElement('div');
  Object.assign(element.style, {
    width: '44px',
    height: '44px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  });
  element.setAttribute('aria-label', label);
  const svg = new DOMParser().parseFromString(POTHOLE_PIN_SVG, 'image/svg+xml').documentElement;
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('style', `width:24px;height:30px;flex-shrink:0;filter:${
    selected
      ? 'drop-shadow(0 0 2px #17231d) drop-shadow(0 0 4px #4CB729)'
      : 'drop-shadow(0 1px 2px rgba(0,0,0,.3))'
  }`);
  element.appendChild(document.importNode(svg, true));
  return element;
}
