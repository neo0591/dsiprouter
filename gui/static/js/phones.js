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

  var phonesTable;
  var carrierOptions = [];

  function fillCarrierSelect($el, selected) {
    $el.empty();
    carrierOptions.forEach(function(group) {
      var opt = $('<option></option>').val(group.gwgroupid).text(group.name + ' (' + group.gwgroupid + ')');
      if (String(group.gwgroupid) === String(selected)) {
        opt.prop('selected', true);
      }
      $el.append(opt);
    });
  }

  function loadCarriers() {
    return $.ajax({
      type: 'GET',
      url: API_BASE_URL + 'carriergroups',
      dataType: 'json'
    }).done(function(response) {
      carrierOptions = (response && response.data) ? response.data : [];
    });
  }

  function reloadPhones() {
    $.ajax({
      type: 'GET',
      url: API_BASE_URL + 'phones',
      dataType: 'json'
    }).done(function(response) {
      var rows = (response && response.data) ? response.data : [];
      phonesTable.clear();
      if (rows.length) {
        phonesTable.rows.add(rows);
      }
      phonesTable.draw();
    }).fail(function(xhr) {
      var msg = (xhr.responseJSON && xhr.responseJSON.msg) ? xhr.responseJSON.msg : 'Failed to load phones';
      showNotification(msg, true);
    });
  }

  function loadUfiSims() {
    return $.ajax({
      type: 'GET',
      url: API_BASE_URL + 'ufi/accounts',
      dataType: 'json'
    }).then(function(response) {
      var rows = (response && response.data) ? response.data : [];
      var sims = [];
      rows.forEach(function(row) {
        (row.sims || []).forEach(function(sim) {
          if (sim && sims.indexOf(sim) === -1) {
            sims.push(sim);
          }
        });
        if (row.sim && sims.indexOf(row.sim) === -1) {
          sims.push(row.sim);
        }
      });
      var $box = $('#ufi-sim-picker').empty();
      if (!sims.length) {
        $box.append('<div class="text-muted">No UFI SIMs</div>');
        return;
      }
      sims.forEach(function(sim) {
        $box.append(
          '<label><input type="checkbox" class="ufi-sim" value="' + sim + '"> ' + sim + '</label>'
        );
      });
    });
  }

  function collectedAppendDids() {
    var values = [];
    $('#ufi-sim-picker .ufi-sim:checked').each(function() {
      values.push($(this).val());
    });
    var pasted = $('#append_dids').val();
    if (pasted) {
      values.push(pasted);
    }
    return values.join(',');
  }

  function openEdit(row) {
    $('#edit_id').val(row.id);
    $('#edit_extension').val(row.extension);
    $('#edit_name').val(row.name);
    $('#edit-phone-label').text(row.extension);
    fillCarrierSelect($('#edit_gwgroupid'), row.gwgroupid);
    $('#edit_dids').val((row.dids || []).join(','));
    $('#append_dids').val('');
    $('#phone-edit-result').addClass('d-none').empty();
    loadUfiSims();
    $('#edit').modal('show');
  }

  $(document).ready(function() {
    phonesTable = $('#phones').DataTable({
      autoWidth: false,
      data: [],
      columns: [
        { data: 'id' },
        { data: 'extension' },
        { data: 'name' },
        { data: 'did_count' },
        {
          data: 'did_text',
          render: function(text) {
            if (!text) {
              return '';
            }
            return text.length > 80 ? text.slice(0, 80) + '…' : text;
          }
        },
        {
          data: null,
          orderable: false,
          render: function() {
            return '<button type="button" class="btn btn-primary btn-sm open-phone-edit"><i class="ti ti-pencil"></i></button>';
          }
        }
      ],
      order: [[1, 'asc']]
    });

    $('#phones tbody').on('click', 'tr, .open-phone-edit', function(evt) {
      evt.stopPropagation();
      var data = phonesTable.row($(this).closest('tr')).data();
      if (data) {
        openEdit(data);
      }
    });

    loadCarriers().always(function() {
      fillCarrierSelect($('#add_gwgroupid'));
      reloadPhones();
    });

    $('#phone-add-form').on('submit', function(evt) {
      evt.preventDefault();
      $.ajax({
        type: 'POST',
        url: API_BASE_URL + 'phones',
        contentType: 'application/json',
        dataType: 'json',
        data: JSON.stringify({
          extension: $.trim($('#add_extension').val()),
          name: $.trim($('#add_name').val()),
          gwgroupid: $('#add_gwgroupid').val()
        })
      }).done(function(response) {
        if (response.kamreload) {
          reloadKamRequired(true);
        }
        showNotification(response.msg || 'Phone created');
        $('#add').modal('hide');
        $('#phone-add-form')[0].reset();
        reloadPhones();
      }).fail(function(xhr) {
        showNotification((xhr.responseJSON && xhr.responseJSON.msg) || 'Create failed', true);
      });
    });

    $('#phone-edit-form').on('submit', function(evt) {
      evt.preventDefault();
      var id = $('#edit_id').val();
      $.ajax({
        type: 'PUT',
        url: API_BASE_URL + 'phones/' + id,
        contentType: 'application/json',
        dataType: 'json',
        data: JSON.stringify({
          extension: $.trim($('#edit_extension').val()),
          name: $.trim($('#edit_name').val()),
          gwgroupid: $('#edit_gwgroupid').val(),
          dids: $('#edit_dids').val()
        })
      }).done(function(response) {
        if (response.kamreload) {
          reloadKamRequired(true);
        }
        showNotification(response.msg || 'Phone updated');
        $('#edit').modal('hide');
        reloadPhones();
      }).fail(function(xhr) {
        showNotification((xhr.responseJSON && xhr.responseJSON.msg) || 'Update failed', true);
      });
    });

    $('#append-did-btn').on('click', function() {
      var id = $('#edit_id').val();
      var extra = collectedAppendDids();
      if (!extra) {
        showNotification('No SIMs selected', true);
        return;
      }
      $.ajax({
        type: 'POST',
        url: API_BASE_URL + 'phones/' + id + '/dids',
        contentType: 'application/json',
        dataType: 'json',
        data: JSON.stringify({ dids: extra })
      }).done(function(response) {
        if (response.kamreload) {
          reloadKamRequired(true);
        }
        var phone = response.data && response.data[0];
        if (phone) {
          $('#edit_dids').val((phone.dids || []).join(','));
        }
        $('#append_dids').val('');
        $('#ufi-sim-picker .ufi-sim').prop('checked', false);
        showNotification(response.msg || 'DIDs appended');
        reloadPhones();
      }).fail(function(xhr) {
        showNotification((xhr.responseJSON && xhr.responseJSON.msg) || 'Append failed', true);
      });
    });
  });
})(window, document);
