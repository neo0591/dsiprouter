/* ============================================================================
   Icon set — inline SVG sprite (stroke-based, 24x24 grid, currentColor)
   Kept local so the console works fully offline / air-gapped.
   ========================================================================= */
(function () {
  'use strict';

  const P = {
    /* navigation */
    gauge: '<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="M13.4 10.6 19 5"/><path d="M3.4 19a9 9 0 1 1 17.2 0"/>',
    router: '<rect x="2" y="14" width="20" height="7" rx="2"/><path d="M6.5 17.5h.01M10 17.5h.01"/><path d="M12 10V7"/><path d="M8.5 5.5 12 9l3.5-3.5"/>',
    signal: '<path d="M4.5 19h.01"/><path d="M8.5 19v-4"/><path d="M13 19v-8"/><path d="M17.5 19v-12"/>',
    sim: '<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><rect x="8.5" y="10" width="6" height="6" rx="1"/><path d="M11.5 10v6"/>',
    phone: '<path d="M15.5 20.5A14 14 0 0 1 3.5 8.5 2 2 0 0 1 5.4 6.5l2.2-.4 1.6 3.6-1.7 1.4a11 11 0 0 0 5.4 5.4l1.4-1.7 3.6 1.6-.4 2.2a2 2 0 0 1-2 1.9Z"/>',
    message: '<path d="M20 12a7.5 7.5 0 0 1-11 6.7L4 20l1.3-4A7.5 7.5 0 1 1 20 12Z"/><path d="M9 11h6M9 14h4"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9.5 9.5 12 7 14.5M12.5 15H17"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
    file: '<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 16.5h4"/>',
    chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 20v-6M12.5 20V9M17 20v-9"/>',
    alert: '<path d="M12 8v5"/><path d="M12 16.5h.01"/><path d="M10.2 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.8 3.9a2 2 0 0 0-3.6 0Z"/>',
    wifi: '<path d="M2.5 8.5a15 15 0 0 1 19 0"/><path d="M6 12.2a9.5 9.5 0 0 1 12 0"/><path d="M9.5 15.8a4.5 4.5 0 0 1 5 0"/><path d="M12 19.5h.01"/>',
    'wifi-off': '<path d="M3 3l18 18"/><path d="M2.5 8.5A15 15 0 0 1 12 4c1.6 0 3.2.3 4.6.8"/><path d="M6 12.2a9.5 9.5 0 0 1 6-2.1"/><path d="M9.5 15.8a4.5 4.5 0 0 1 5 0"/><path d="M12 19.5h.01"/>',
    'wifi-search': '<path d="M2.5 8.5a15 15 0 0 1 19 0"/><path d="M6 12.2a9.5 9.5 0 0 1 12 0"/><circle cx="11" cy="17.5" r="3"/><path d="M13.4 19.9 16 22.5"/>',
    'wifi-on': '<path d="M2.5 8.5a15 15 0 0 1 19 0"/><path d="M6 12.2a9.5 9.5 0 0 1 12 0"/><path d="M9.5 15.8a4.5 4.5 0 0 1 5 0"/><path d="M12 19.5h.01"/>',
    'phone-wifi': '<path d="M14 20.5A13 13 0 0 1 3.5 10 2 2 0 0 1 5.3 8l2-.4 1.4 3.2-1.5 1.3a10 10 0 0 0 4.7 4.7l1.3-1.5 3.2 1.4-.4 2a2 2 0 0 1-2 1.8Z"/><path d="M16 4.5a5 5 0 0 1 3.5 0"/><path d="M15 7a3 3 0 0 1 2 0"/>',
    hotspot: '<circle cx="12" cy="12" r="2.5"/><path d="M8 8a5.7 5.7 0 0 0 0 8M16 16a5.7 5.7 0 0 0 0-8"/><path d="M5 5a10 10 0 0 0 0 14M19 19a10 10 0 0 0 0-14"/>',
    'hotspot-off': '<circle cx="12" cy="12" r="2.5"/><path d="M3 3l18 18"/><path d="M8 8a5.7 5.7 0 0 0 0 8"/><path d="M5 5a10 10 0 0 0-1.6 12"/>',
    'sim-key': '<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><circle cx="12" cy="14" r="2"/><path d="M12 16v2.5"/>',
    'sim-lock': '<path d="M6 3h8l4 4v6"/><path d="M5 14v-1a1 1 0 0 1 1-1h8"/><path d="M5 14h10v7H5z"/><path d="M8 12V9.5a2 2 0 0 1 4 0V12"/>',
    power: '<path d="M12 3v9"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.4-3.6"/><path d="M4 13a8 8 0 0 0 14.4 3.6"/><path d="M5.5 3.5v4h4"/><path d="M18.5 20.5v-4h-4"/>',
    /* actions */
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4-2v-4Z"/>',
    download: '<path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M4 19h16"/>',
    upload: '<path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M4 19h16"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="M4.5 12.5 9 17l10.5-10.5"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12.5 11 15.5l5-5.5"/>',
    'x-circle': '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M3 3l18 18"/><path d="M10.6 10.6A3 3 0 0 0 13.4 13.4"/><path d="M7 7.2C5 8.4 3.4 10.2 2.5 12c0 0 3.5 6.5 9.5 6.5 1.6 0 3-.3 4.2-.9"/><path d="M16.8 16.3C19 15.1 20.6 13.3 21.5 12c0 0-3.5-6.5-9.5-6.5-1.1 0-2.1.2-3 .5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.5 12a7.5 7.5 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-2-1.2L14.7 3H9.3l-.4 2.7a7.6 7.6 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.5 7.5 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 2 1.2l.4 2.7h5.4l.4-2.7a7.6 7.6 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6"/>',
    'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
    expand: '<path d="M9 4H4v5"/><path d="M15 20h5v-5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M15 6V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1"/>',
    'arrow-up': '<path d="M12 20V5"/><path d="M6 11l6-6 6 6"/>',
    'arrow-down': '<path d="M12 4v15"/><path d="M6 13l6 6 6-6"/>',
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/>',
    calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    layers: '<path d="M12 3 3 7.5 12 12l9-4.5L12 3Z"/><path d="M3 12.5 12 17l9-4.5"/><path d="M3 17 12 21.5 21 17"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3"/>',
    memory: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 11v2M11 11v2M15 11v2"/><path d="M7 3v4M12 3v4M17 3v4M7 17v4M12 17v4M17 17v4"/>',
    storage: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    activity: '<path d="M3 12h4l2.5-7 4 14L16 12h5"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.4 8.4-8 9.5C7.4 20.4 4 17 4 12V6l8-3Z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/>',
    antenna: '<path d="M12 12v9"/><path d="M4 5a11 11 0 0 0 0 12"/><path d="M20 5a11 11 0 0 1 0 12"/><path d="M7 8a6 6 0 0 0 0 6"/><path d="M17 8a6 6 0 0 1 0 6"/><circle cx="12" cy="10" r="2"/>',
    send: '<path d="M21 3 3 10.5l7.5 3L14 21l7-18Z"/><path d="M10.5 13.5 21 3"/>',
    bell: '<path d="M6 9a6 6 0 1 1 12 0c0 4.5 1.5 6 1.5 6h-15S6 13.5 6 9Z"/><path d="M10 18.5a2 2 0 0 0 4 0"/>',
    link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.5 6.3"/><path d="M14 10.5a4 4 0 0 0-5.7 0L5.5 13.3a4 4 0 0 0 5.7 5.7l1.3-1.3"/>',
    key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8"/><path d="M15.5 6.5 18 9"/><path d="M18 4l2 2"/>',
    user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    'panel-left': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9.5 4v16"/>',
    pause: '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
    play: '<path d="M7 4.5 19 12 7 19.5v-15Z"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
    'trend-up': '<path d="M3 17l5.5-5.5 3.5 3.5L21 6"/><path d="M15 6h6v6"/>',
    'trend-down': '<path d="M3 7l5.5 5.5L12 9l9 9"/><path d="M15 18h6v-6"/>',
    lock: '<rect x="4.5" y="10" width="15" height="10" rx="2"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
    building: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M8.5 7h.01M12 7h.01M15.5 7h.01M8.5 11h.01M12 11h.01M15.5 11h.01M10 21v-4h4v4"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M4 17.5l4.5-4 3.5 3 3-2.5 4.5 4"/>',
    phoneOff: '<path d="M3 3l18 18"/><path d="M14.5 15.5 13 17l-1.7-1.6a10 10 0 0 1-3.7-3.7L6 10l1.5-1.5"/><path d="M6.4 6.4 5.4 6.5l-2 2a1.6 1.6 0 0 0-.3 1.8 13 13 0 0 0 4.6 5.5"/>'
  };

  function svg(name, size, cls) {
    const body = P[name] || P.info;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
      (size ? ' width="' + size + '" height="' + size + '"' : '') +
      (cls ? ' class="' + cls + '"' : '') + '>' + body + '</svg>';
  }

  window.Icon = { svg, paths: P };
})();
