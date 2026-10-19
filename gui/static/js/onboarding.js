(function(window, document) {
  'use strict';

  if (typeof showNotification === "undefined") {
    throw new Error("showNotification() is required and is not defined");
  }
  if (typeof reloadKamRequired === "undefined") {
    throw new Error("reloadKamRequired() is required and is not defined");
  }
  if (typeof API_BASE_URL === "undefined") {
    throw new Error("API_BASE_URL is required and is not defined");
  }

  var accountsTable;

  function showBox(selector, html, isError) {
    var box = $(selector);
    box.removeClass('d-none error');
    if (isError) {
      box.addClass('error');
    }
    box.html(html);
  }

  function hideBox(selector) {
    $(selector).addClass('d-none').removeClass('error').empty();
  }

  function reloadAccounts() {
    $.ajax({
      type: 'GET',
      url: API_BASE_URL + 'ufi/accounts',
      dataType: 'json'
    }).done(function(response) {
      var rows = (response && response.data) ? response.data : [];
      accountsTable.clear();
      if (rows.length) {
        accountsTable.rows.add(rows);
      }
      accountsTable.draw();
    }).fail(function(xhr) {
      var msg = (xhr.responseJSON && xhr.responseJSON.msg) ? xhr.responseJSON.msg : 'Failed to load accounts';
      showNotification(msg, true);
    });
  }

  function parseCsv(text) {
    var rows = [];
    String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).forEach(function(line) {
      line = line.trim();
      if (!line) {
        return;
      }
      var parts = line.split(/[,\t;]/).map(function(part) {
        return part.trim().replace(/^"|"$/g, '');
      });
      if (!parts[0]) {
        return;
      }
      var header = parts[0].toLowerCase();
      if (header === 'imei' || header === 'username') {
        return;
      }
      rows.push({
        imei: parts[0],
        sim: parts[1] || ''
      });
    });
    return rows;
  }

  function readFileText(file) {
    var deferred = $.Deferred();
    if (!file) {
      deferred.resolve('');
      return deferred.promise();
    }
    var reader = new FileReader();
    reader.onload = function() {
      deferred.resolve(reader.result || '');
    };
    reader.onerror = function() {
      deferred.reject(reader.error);
    };
    reader.readAsText(file);
    return deferred.promise();
  }

  function createAccount(evt) {
    evt.preventDefault();
    var imei = $.trim($('#acct_imei').val());
    var sim = $.trim($('#acct_sim').val());
    if (!imei) {
      showNotification('IMEI is required', true);
      return;
    }

    var $btn = $('#onboarding-submit');
    $btn.prop('disabled', true);
    hideBox('#onboarding-result');

    $.ajax({
      type: 'POST',
      url: API_BASE_URL + 'ufi/accounts',
      dataType: 'json',
      contentType: 'application/json',
      data: JSON.stringify({ imei: imei, sim: sim })
    }).done(function(response) {
      if (response && response.kamreload) {
        reloadKamRequired(true);
      }
      showNotification(response.msg || 'Account created');
      $('#onboarding-form')[0].reset();
      $('#add').modal('hide');
      reloadAccounts();
    }).fail(function(xhr) {
      var msg = (xhr.responseJSON && xhr.responseJSON.msg) ? xhr.responseJSON.msg : 'Account creation failed';
      showBox('#onboarding-result', msg, true);
      showNotification(msg, true);
    }).always(function() {
      $btn.prop('disabled', false);
    });
  }

  function updateAccount(evt) {
    evt.preventDefault();
    var id = $('#edit_id').val();
    var imei = $.trim($('#edit_imei').val());
    var sim = $.trim($('#edit_sim').val());
    if (!id || !imei) {
      showNotification('IMEI is required', true);
      return;
    }
    var $btn = $('#onboarding-edit-submit');
    $btn.prop('disabled', true);
    hideBox('#onboarding-edit-result');
    $.ajax({
      type: 'PUT',
      url: API_BASE_URL + 'ufi/accounts/' + id,
      dataType: 'json',
      contentType: 'application/json',
      data: JSON.stringify({ imei: imei, sim: sim })
    }).done(function(response) {
      if (response && response.kamreload) {
        reloadKamRequired(true);
      }
      showNotification(response.msg || 'Account updated');
      $('#edit').modal('hide');
      reloadAccounts();
    }).fail(function(xhr) {
      var msg = (xhr.responseJSON && xhr.responseJSON.msg) ? xhr.responseJSON.msg : 'Account update failed';
      showBox('#onboarding-edit-result', msg, true);
      showNotification(msg, true);
    }).always(function() {
      $btn.prop('disabled', false);
    });
  }

  function deleteAccount() {
    var id = $('#delete_id').val();
    if (!id) {
      return;
    }
    var $btn = $('#onboarding-delete-confirm');
    $btn.prop('disabled', true);
    $.ajax({
      type: 'DELETE',
      url: API_BASE_URL + 'ufi/accounts/' + id,
      dataType: 'json'
    }).done(function(response) {
      if (response && response.kamreload) {
        reloadKamRequired(true);
      }
      showNotification(response.msg || 'Account deleted');
      $('#delete').modal('hide');
      reloadAccounts();
    }).fail(function(xhr) {
      var msg = (xhr.responseJSON && xhr.responseJSON.msg) ? xhr.responseJSON.msg : 'Account delete failed';
      showNotification(msg, true);
    }).always(function() {
      $btn.prop('disabled', false);
    });
  }

  function importAccounts(evt) {
    evt.preventDefault();
    var $btn = $('#onboarding-import-submit');
    $btn.prop('disabled', true);
    hideBox('#onboarding-import-result');

    readFileText($('#importFile')[0].files[0]).then(function(fileText) {
      var text = fileText || $('#importText').val();
      var accounts = parseCsv(text);
      if (!accounts.length) {
        showNotification('No valid IMEI/SIM rows found', true);
        $btn.prop('disabled', false);
        return;
      }

      return $.ajax({
        type: 'POST',
        url: API_BASE_URL + 'ufi/accounts/import',
        dataType: 'json',
        contentType: 'application/json',
        data: JSON.stringify({ accounts: accounts })
      }).done(function(response) {
        if (response && response.kamreload) {
          reloadKamRequired(true);
        }
        var summary = (response && response.data && response.data[0]) ? response.data[0] : {};
        var html = (response.msg || 'Import complete') +
          (summary.errors && summary.errors.length
            ? '<br>' + summary.errors.map(function(err) {
                return 'row ' + err.row + ': ' + err.msg;
              }).join('<br>')
            : '');
        showBox('#onboarding-import-result', html, !!summary.skipped);
        showNotification(response.msg || 'Import complete');
        reloadAccounts();
        if (!summary.skipped) {
          $('#import').modal('hide');
          $('#onboarding-import-form')[0].reset();
        }
      }).fail(function(xhr) {
        var msg = (xhr.responseJSON && xhr.responseJSON.msg) ? xhr.responseJSON.msg : 'Import failed';
        showBox('#onboarding-import-result', msg, true);
        showNotification(msg, true);
      });
    }).always(function() {
      $btn.prop('disabled', false);
    });
  }

  $(document).ready(function() {
    accountsTable = $('#accounts').DataTable({
      autoWidth: false,
      data: [],
      columns: [
        { data: 'id' },
        { data: 'imei' },
        {
          data: 'sims',
          render: function(sims, type, row) {
            if (Array.isArray(sims) && sims.length) {
              return sims.join(', ');
            }
            return row.sim || '';
          }
        },
        { data: 'domain' },
        {
          data: 'online',
          render: function(online, type, row) {
            if (online) {
              return '<span class="badge bg-success">online</span>' +
                (row.received ? ' ' + row.received : '');
            }
            return '<span class="badge bg-secondary">offline</span>';
          }
        },
        {
          data: null,
          orderable: false,
          searchable: false,
          render: function() {
            return '<button type="button" class="btn btn-primary btn-sm open-ufi-edit" title="Edit"><i class="ti ti-pencil"></i></button>';
          }
        },
        {
          data: null,
          orderable: false,
          searchable: false,
          render: function() {
            return '<button type="button" class="btn btn-danger btn-sm open-ufi-delete" title="Delete"><i class="ti ti-trash"></i></button>';
          }
        }
      ],
      order: [[0, 'desc']]
    });

    reloadAccounts();
    $('#onboarding-form').on('submit', createAccount);
    $('#onboarding-edit-form').on('submit', updateAccount);
    $('#onboarding-import-form').on('submit', importAccounts);
    $('#onboarding-delete-confirm').on('click', deleteAccount);
    $('#accounts tbody').on('click', '.open-ufi-edit', function(evt) {
      evt.stopPropagation();
      var row = accountsTable.row($(this).closest('tr')).data();
      if (!row) {
        return;
      }
      $('#edit_id').val(row.id);
      $('#edit_imei').val(row.imei);
      $('#edit_sim').val((row.sims && row.sims.length) ? row.sims.join(',') : (row.sim || ''));
      hideBox('#onboarding-edit-result');
      $('#edit').modal('show');
    });
    $('#accounts tbody').on('click', '.open-ufi-delete', function(evt) {
      evt.stopPropagation();
      var row = accountsTable.row($(this).closest('tr')).data();
      if (!row) {
        return;
      }
      $('#delete_id').val(row.id);
      $('#delete_label').text(row.imei + (row.sim ? ' / ' + row.sim : ''));
      $('#delete').modal('show');
    });
    $('#add').on('show.bs.modal', function() {
      hideBox('#onboarding-result');
    });
    $('#import').on('show.bs.modal', function() {
      hideBox('#onboarding-import-result');
    });
  });
})(window, document);
