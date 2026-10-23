(function() {
  'use strict';

  if (typeof API_BASE_URL === 'undefined') {
    throw new Error('API_BASE_URL is required and is not defined');
  }
  if (typeof showNotification === 'undefined') {
    throw new Error('showNotification() is required and is not defined');
  }

  var devicesTable;

  function badge(ok, onText, offText) {
    return ok
      ? '<span class="badge bg-success">' + onText + '</span>'
      : '<span class="badge bg-secondary">' + offText + '</span>';
  }

  function loadConfig() {
    return $.ajax({
      type: 'GET',
      url: API_BASE_URL + 'ufi/config',
      dataType: 'json'
    }).done(function(response) {
      var cfg = (response && response.data && response.data[0]) ? response.data[0] : {};
      $('#cfg_secret').val(cfg.secret_key || '');
      $('#cfg_sip_host').val(cfg.sip_host || '');
      $('#cfg_sip_port').val(cfg.sip_port || 10560);
      $('#cfg_transport').val(cfg.transport || 'UDP');
      $('#cfg_auto').val(cfg.auto_provision ? '1' : '0');
      $('#cfg_base_url').val(cfg.base_url || '');
      $('#cfg_ws_url').val(cfg.ws_url || '');
    });
  }

  function saveConfig(evt) {
    evt.preventDefault();
    $.ajax({
      type: 'PUT',
      url: API_BASE_URL + 'ufi/config',
      contentType: 'application/json',
      dataType: 'json',
      data: JSON.stringify({
        secret_key: $.trim($('#cfg_secret').val()),
        sip_host: $.trim($('#cfg_sip_host').val()),
        sip_port: parseInt($('#cfg_sip_port').val(), 10) || 10560,
        transport: $('#cfg_transport').val(),
        auto_provision: $('#cfg_auto').val() === '1',
        base_url: $.trim($('#cfg_base_url').val()),
        ws_url: $.trim($('#cfg_ws_url').val())
      })
    }).done(function(response) {
      showNotification(response.msg || 'Saved');
      loadConfig();
    }).fail(function(xhr) {
      var msg = (xhr.responseJSON && xhr.responseJSON.msg) ? xhr.responseJSON.msg : 'Save failed';
      showNotification(msg, true);
    });
  }

  function reloadDevices() {
    $.ajax({
      type: 'GET',
      url: API_BASE_URL + 'ufi/devices',
      dataType: 'json'
    }).done(function(response) {
      var rows = (response && response.data) ? response.data : [];
      devicesTable.clear();
      if (rows.length) {
        devicesTable.rows.add(rows);
      }
      devicesTable.draw();
    }).fail(function(xhr) {
      var msg = (xhr.responseJSON && xhr.responseJSON.msg) ? xhr.responseJSON.msg : 'Failed to load devices';
      showNotification(msg, true);
    });
  }

  function sanitizeStatus(raw) {
    var obj = raw;
    if (typeof raw === 'string') {
      try {
        obj = JSON.parse(raw);
      } catch (err) {
        return raw;
      }
    }
    if (!obj || typeof obj !== 'object') {
      return raw || '';
    }
    ['wlanPassword', 'hotspotPassword', 'sippassWord', 'password'].forEach(function(key) {
      if (obj[key]) {
        obj[key] = '******';
      }
    });
    return JSON.stringify(obj, null, 2);
  }

  function openStatus(imei) {
    $('#status-imei').text(imei);
    $('#status-json').text('...');
    $('#ufi-status-modal').modal('show');
    $.ajax({
      type: 'GET',
      url: API_BASE_URL + 'ufi/devices/' + encodeURIComponent(imei),
      dataType: 'json'
    }).done(function(response) {
      var item = (response && response.data && response.data[0]) ? response.data[0] : {};
      $('#status-json').text(sanitizeStatus(item.status_json || item.raw_json || item));
    }).fail(function(xhr) {
      var msg = (xhr.responseJSON && xhr.responseJSON.msg) ? xhr.responseJSON.msg : 'Failed to load status';
      $('#status-json').text(msg);
    });
  }

  function openCommand(imei) {
    $('#cmd-imei').text(imei);
    $('#cmd-result').addClass('d-none').empty();
    $('#ufi-cmd-modal').modal('show');
  }

  function toggleCmdExtra() {
    var cmd = $('#cmd-name').val();
    if (cmd === 'wifi_connect' || cmd === 'hotspot_on') {
      $('#cmd-wifi').removeClass('d-none');
    } else {
      $('#cmd-wifi').addClass('d-none');
    }
  }

  function sendCommand(evt) {
    evt.preventDefault();
    var imei = $('#cmd-imei').text();
    var cmd = $('#cmd-name').val();
    var body = { cmd: cmd };
    if (cmd === 'wifi_connect') {
      body.wlanName = $.trim($('#cmd-ssid').val());
      body.wlanPassword = $.trim($('#cmd-pass').val());
    }
    if (cmd === 'hotspot_on') {
      body.hotspotName = $.trim($('#cmd-ssid').val());
      body.hotspotPassword = $.trim($('#cmd-pass').val());
    }
    $.ajax({
      type: 'POST',
      url: API_BASE_URL + 'ufi/devices/' + encodeURIComponent(imei) + '/command',
      contentType: 'application/json',
      dataType: 'json',
      data: JSON.stringify(body)
    }).done(function(response) {
      var result = (response && response.data && response.data[0]) ? response.data[0] : response;
      $('#cmd-result').removeClass('d-none').text(JSON.stringify(result.reply || result, null, 2));
      showNotification(response.msg || 'command sent');
    }).fail(function(xhr) {
      var msg = (xhr.responseJSON && xhr.responseJSON.msg) ? xhr.responseJSON.msg : 'Command failed';
      $('#cmd-result').removeClass('d-none error').addClass('error').text(msg);
      showNotification(msg, true);
    });
  }

  $(document).ready(function() {
    devicesTable = $('#ufi-devices').DataTable({
      autoWidth: false,
      data: [],
      columns: [
        { data: 'imei' },
        { data: 'sim_number' },
        { data: 'lte_status' },
        {
          data: 'volte_status',
          render: function(value) {
            return value === '1' ? 'on' : (value || '');
          }
        },
        {
          data: 'voip_status',
          render: function(value, type, row) {
            if (value === '1' || row.sip_reg_status === 'success') {
              return badge(true, 'SIP', 'SIP');
            }
            return badge(false, 'SIP', row.sip_reg_status || 'off');
          }
        },
        { data: 'signal_level' },
        { data: 'network_type' },
        {
          data: 'ws_online',
          render: function(online) {
            return badge(!!online, 'WS', 'WS');
          }
        },
        { data: 'last_seen' },
        {
          data: 'online',
          render: function(online) {
            return badge(!!online, 'online', 'offline');
          }
        },
        {
          data: null,
          orderable: false,
          render: function(row) {
            return '<button type="button" class="btn btn-secondary btn-sm open-ufi-status">status</button> ' +
              '<button type="button" class="btn btn-primary btn-sm open-ufi-cmd">cmd</button>';
          }
        }
      ],
      order: [[8, 'desc']]
    });

    loadConfig();
    reloadDevices();
    $('#ufi-config-form').on('submit', saveConfig);
    $('#cmd-name').on('change', toggleCmdExtra);
    $('#ufi-cmd-form').on('submit', sendCommand);
    $('#ufi-devices tbody').on('click', '.open-ufi-status', function() {
      var row = devicesTable.row($(this).closest('tr')).data();
      if (row) {
        openStatus(row.imei);
      }
    });
    $('#ufi-devices tbody').on('click', '.open-ufi-cmd', function() {
      var row = devicesTable.row($(this).closest('tr')).data();
      if (row) {
        openCommand(row.imei);
      }
    });
    setInterval(reloadDevices, 10000);
  });
})();
