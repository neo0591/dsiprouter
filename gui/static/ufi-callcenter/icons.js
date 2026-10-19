/* ============================================================================
   Icon set — inline SVG (24x24, stroke, currentColor). Fully offline.
   ========================================================================= */
(function () {
  'use strict';

  const P = {
    /* nav */
    network:'<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M12 7.5v4M10.5 13.5 6.5 17M13.5 13.5l4 3.5"/>',
    pool:'<rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="14" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="15" width="7" height="6" rx="1.5"/><rect x="14" y="15" width="7" height="6" rx="1.5"/>',
    headset:'<path d="M4 13a8 8 0 0 1 16 0"/><rect x="2.5" y="13" width="4" height="6.5" rx="2"/><rect x="17.5" y="13" width="4" height="6.5" rx="2"/><path d="M19.5 19.5v.5a2.5 2.5 0 0 1-2.5 2.5H13"/>',
    route:'<circle cx="5.5" cy="5.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/><path d="M8 5.5h5.5A3.5 3.5 0 0 1 17 9v0a3.5 3.5 0 0 1-3.5 3.5H10A3.5 3.5 0 0 0 6.5 16v0A2.5 2.5 0 0 0 9 18.5"/>',
    queue:'<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8.5 6H18a2 2 0 0 1 2 2v1M8.5 18H18a2 2 0 0 0 2-2v-1"/>',
    ivr:'<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 8.5h17M8 8.5v12"/><path d="M11.5 12h5M11.5 15.5h3"/>',
    stethoscope:'<path d="M6 3v5a4 4 0 0 0 8 0V3"/><path d="M6 3H4.5M14 3h1.5"/><path d="M10 12v2.5a5.5 5.5 0 0 0 11 0V13"/><circle cx="20.5" cy="11" r="2"/>',
    pulse:'<path d="M3 12h4l2.5-7 4 14L16 12h5"/>',
    steth:'<circle cx="12" cy="12" r="3"/><path d="M12 15v3.5a4.5 4.5 0 0 0 9 0"/>',
    layers:'<path d="M12 3 3 7.5 12 12l9-4.5L12 3Z"/><path d="M3 12.5 12 17l9-4.5"/><path d="M3 17 12 21.5 21 17"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="M19.5 12a7.5 7.5 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-2-1.2L14.7 3H9.3l-.4 2.7a7.6 7.6 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.5 7.5 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 2 1.2l.4 2.7h5.4l.4-2.7a7.6 7.6 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z"/>',
    /* devices */
    sim:'<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><rect x="8.5" y="10" width="6" height="6" rx="1"/><path d="M11.5 10v6"/>',
    phone:'<path d="M15.5 20.5A14 14 0 0 1 3.5 8.5 2 2 0 0 1 5.4 6.5l2.2-.4 1.6 3.6-1.7 1.4a11 11 0 0 0 5.4 5.4l1.4-1.7 3.6 1.6-.4 2.2a2 2 0 0 1-2 1.9Z"/>',
    phoneIn:'<path d="M15.5 20.5A14 14 0 0 1 3.5 8.5 2 2 0 0 1 5.4 6.5l2.2-.4 1.6 3.6-1.7 1.4a11 11 0 0 0 5.4 5.4l1.4-1.7 3.6 1.6-.4 2.2a2 2 0 0 1-2 1.9Z"/><path d="M15 8.5 13 11l2 2 2.5-2"/>',
    phoneOut:'<path d="M15.5 20.5A14 14 0 0 1 3.5 8.5 2 2 0 0 1 5.4 6.5l2.2-.4 1.6 3.6-1.7 1.4a11 11 0 0 0 5.4 5.4l1.4-1.7 3.6 1.6-.4 2.2a2 2 0 0 1-2 1.9Z"/><path d="M14 8.5h4.5V4"/>',
    mobile:'<rect x="6.5" y="2.5" width="11" height="19" rx="2"/><path d="M10.5 18.5h3"/>',
    router:'<rect x="2" y="14" width="20" height="7" rx="2"/><path d="M6.5 17.5h.01M10 17.5h.01"/><path d="M12 10V7"/><path d="M8.5 5.5 12 9l3.5-3.5"/>',
    server:'<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    database:'<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    antenna:'<path d="M12 12v9"/><path d="M4 5a11 11 0 0 0 0 12"/><path d="M20 5a11 11 0 0 1 0 12"/><path d="M7 8a6 6 0 0 0 0 6"/><path d="M17 8a6 6 0 0 1 0 6"/><circle cx="12" cy="10" r="2"/>',
    signal:'<path d="M4.5 19h.01"/><path d="M8.5 19v-4"/><path d="M13 19v-8"/><path d="M17.5 19v-12"/>',
    user:'<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    users:'<circle cx="9" cy="8.5" r="3"/><path d="M3 19a6 6 0 0 1 12 0"/><path d="M16 5.5a3 3 0 0 1 0 6"/><path d="M17.5 14.2A6 6 0 0 1 21 19"/>',
    /* actions */
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/>',
    filter:'<path d="M3 5h18l-7 8v6l-4-2v-4Z"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    minus:'<path d="M5 12h14"/>',
    x:'<path d="M6 6l12 12M18 6 6 18"/>',
    check:'<path d="M4.5 12.5 9 17l10.5-10.5"/>',
    'check-circle':'<circle cx="12" cy="12" r="9"/><path d="M8 12.5 11 15.5l5-5.5"/>',
    'x-circle':'<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    alert:'<path d="M12 8v5"/><path d="M12 16.5h.01"/><path d="M10.2 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.8 3.9a2 2 0 0 0-3.6 0Z"/>',
    eye:'<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
    refresh:'<path d="M20 11a8 8 0 0 0-14.4-3.6"/><path d="M4 13a8 8 0 0 0 14.4 3.6"/><path d="M5.5 3.5v4h4"/><path d="M18.5 20.5v-4h-4"/>',
    power:'<path d="M12 3v9"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/>',
    trash:'<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
    copy:'<rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M15 6V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1"/>',
    clipboard:'<rect x="5" y="4" width="14" height="17" rx="1.5"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 10h6M9 14h6M9 18h3"/>',
    external:'<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    link:'<path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.5 6.3"/><path d="M14 10.5a4 4 0 0 0-5.7 0L5.5 13.3a4 4 0 0 0 5.7 5.7l1.3-1.3"/>',
    download:'<path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M4 19h16"/>',
    upload:'<path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M4 19h16"/>',
    save:'<path d="M4 4h12l4 4v12H4z"/><path d="M8 4v6h8V4"/><rect x="8" y="14" width="8" height="6"/>',
    play:'<path d="M7 4.5 19 12 7 19.5v-15Z"/>',
    pause:'<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
    send:'<path d="M21 3 3 10.5l7.5 3L14 21l7-18Z"/><path d="M10.5 13.5 21 3"/>',
    link:'<path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.5 6.3"/><path d="M14 10.5a4 4 0 0 0-5.7 0L5.5 13.3a4 4 0 0 0 5.7 5.7l1.3-1.3"/>',
    key:'<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8"/><path d="M15.5 6.5 18 9"/><path d="M18 4l2 2"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/>',
    calendar:'<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    chevron:'<path d="M9 6l6 6-6 6"/>',
    'chevron-down':'<path d="M6 9l6 6 6-6"/>',
    'chevron-left':'<path d="M15 6l-6 6 6 6"/>',
    'chevron-up':'<path d="M6 15l6-6 6 6"/>',
    menu:'<path d="M4 7h16M4 12h16M4 17h16"/>',
    'panel-left':'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9.5 4v16"/>',
    grid:'<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    list:'<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    drag:'<path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01"/>',
    terminal:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9.5 9.5 12 7 14.5M12.5 15H17"/>',
    file:'<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 16.5h4"/>',
    chart:'<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 20v-6M12.5 20V9M17 20v-9"/>',
    'trend-up':'<path d="M3 17l5.5-5.5 3.5 3.5L21 6"/><path d="M15 6h6v6"/>',
    'trend-down':'<path d="M3 7l5.5 5.5L12 9l9 9"/><path d="M15 18h6v-6"/>',
    lock:'<rect x="4.5" y="10" width="15" height="10" rx="2"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
    shield:'<path d="M12 3l8 3v6c0 5-3.4 8.4-8 9.5C7.4 20.4 4 17 4 12V6l8-3Z"/>',
    globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/>',
    building:'<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M8.5 7h.01M12 7h.01M15.5 7h.01M8.5 11h.01M12 11h.01M15.5 11h.01M10 21v-4h4v4"/>',
    headset2:'<path d="M4 13a8 8 0 1 1 16 0"/><rect x="2.5" y="13" width="4" height="6.5" rx="2"/><rect x="17.5" y="13" width="4" height="6.5" rx="2"/>',
    mic:'<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3M9 21h6"/>',
    'mic-off':'<path d="M3 3l18 18"/><path d="M9 9v2a3 3 0 0 0 4.5 2.6"/><path d="M15 11V6a3 3 0 0 0-5.6-1.5"/><path d="M5 11a7 7 0 0 0 10.9 5.8M19 11a7 7 0 0 1-.6 2.8"/><path d="M12 18v3M9 21h6"/>',
    headphones:'<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2.5" y="13.5" width="4.5" height="7" rx="2"/><rect x="17" y="13.5" width="4.5" height="7" rx="2"/>',
    logout:'<path d="M14 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3"/><path d="M9 12h12M17.5 8.5 21 12l-3.5 3.5"/>',
    bell:'<path d="M6 9a6 6 0 1 1 12 0c0 4.5 1.5 6 1.5 6h-15S6 13.5 6 9Z"/><path d="M10 18.5a2 2 0 0 0 4 0"/>',
    target:'<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
    'repeat':'<path d="M4 10V8a3 3 0 0 1 3-3h10l-3-3"/><path d="M20 14v2a3 3 0 0 1-3 3H7l3 3"/>',
    shuffle:'<path d="M3 6h3.5l3 5m0 0 3 5H20"/><path d="M3 18h3.5l3-5"/><path d="M14 11l2.5-5H20M17 3l3 3-3 3M17 15l3 3-3 3"/>',
    weight:'<path d="M12 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"/><path d="M6.5 8h11l2.5 12H4L6.5 8Z"/>',
    'alert-tri':'<path d="M12 8v5"/><path d="M12 16.5h.01"/><path d="M10.2 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.8 3.9a2 2 0 0 0-3.6 0Z"/>',
    branch:'<circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 7.5v9"/><path d="M15.5 12H8.5a2.5 2.5 0 0 0 0 5"/>',
    webhook:'<path d="M9 8.5 12 4l3 4.5"/><path d="M15 15.5 12 20l-3-4.5"/><path d="M12 4v16"/>',
    inbox:'<path d="M3.5 13.5 6 5h12l2.5 8.5V20a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1Z"/><path d="M3.5 13.5H9a3 3 0 0 0 6 0h5.5"/>',
    bolt:'<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
    sliders:'<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>'
  };

  function svg(name, size, cls) {
    const body = P[name] || P.info;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
      (size ? ' width="' + size + '" height="' + size + '"' : '') +
      (cls ? ' class="' + cls + '"' : '') + '>' + body + '</svg>';
  }

  window.Icon = { svg: svg, paths: P };
})();