(function() {
  'use strict';

  if (typeof API_BASE_URL === 'undefined') {
    throw new Error('API_BASE_URL is required and is not defined');
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function markCard(step, state) {
    var card = document.querySelector('.setup-card[data-step="' + step + '"]');
    if (!card) {
      return;
    }
    card.classList.remove('is-done', 'is-next');
    if (state) {
      card.classList.add(state);
    }
  }

  $(document).ready(function() {
    $.ajax({
      type: 'GET',
      url: API_BASE_URL + 'ufi/setup',
      dataType: 'json'
    }).done(function(response) {
      var data = (response && response.data && response.data[0]) ? response.data[0] : {};
      var sip = (data.sip_host || '') + ':' + (data.sip_port || '5060');
      $('#setup-sip-target').text(sip);
      $('#ufi-sip-copy').text(sip);
      $('#stat-ufi').text(data.ufi_total || 0);
      $('#stat-online').text(data.ufi_online || 0);
      $('#stat-sims').text(data.sim_aliases || 0);
      $('#stat-phones').text((data.phones_total || 0) + ' / ' + (data.dids_bound || 0));
      $('#stat-gws').text((data.vos_gateways || []).length);

      var vosHtml = '';
      (data.vos_groups || []).forEach(function(group) {
        vosHtml += '<li>' + escapeHtml(group.name) + ' (#' + escapeHtml(group.id) + ')</li>';
      });
      (data.vos_gateways || []).forEach(function(gw) {
        vosHtml += '<li>' + escapeHtml(gw.address) + '</li>';
      });
      if (!vosHtml) {
        vosHtml = '<li>—</li>';
      }
      $('#vos-check').html(vosHtml);

      var phoneHtml = '';
      (data.phones || []).forEach(function(phone) {
        var dids = String(phone.dids || '').split(/[\s,;]+/).filter(Boolean);
        phoneHtml += '<li>' + escapeHtml(phone.extension) + ' · DID ' + dids.length + '</li>';
      });
      $('#phone-check').html(phoneHtml || '<li>—</li>');

      var next = data.next_step || 1;
      [1, 2, 3, 4].forEach(function(step) {
        if (step < next) {
          markCard(step, 'is-done');
        } else if (step === next) {
          markCard(step, 'is-next');
        } else {
          markCard(step, '');
        }
      });

      var $tbody = $('#reg-table tbody');
      $tbody.empty();
      var regs = data.registrations || [];
      if (!regs.length) {
        $tbody.append('<tr><td colspan="4">—</td></tr>');
      } else {
        regs.forEach(function(row) {
          $tbody.append(
            '<tr><td>' + escapeHtml(row.imei) +
            '</td><td>' + escapeHtml(row.received) +
            '</td><td>' + escapeHtml(row.expires) +
            '</td><td>' + escapeHtml(row.user_agent) +
            '</td></tr>'
          );
        });
      }
    }).fail(function(xhr) {
      var msg = (xhr.responseJSON && xhr.responseJSON.msg) ? xhr.responseJSON.msg : 'Failed to load setup status';
      if (typeof showNotification === 'function') {
        showNotification(msg, true);
      }
    });
  });
})();
