;(function (window, document) {
  'use strict';

  // throw an error if required globals not defined
  if (typeof API_BASE_URL === "undefined") {
    throw new Error("API_BASE_URL is required and is not defined");
  }
  if (typeof delayedCallback === "undefined" || typeof throttledCallback === "undefined") {
    throw new Error("delayedCallback() and throttledCallback() are required and are not defined");
  }

  // globals for this script
  var epgroup_select = $("#endpointgroups");
  var loading_spinner = $('#loading-spinner');
  var showallcalls_inp = $('#toggle_completed_calls');
  var cdr_table = null;

  /**
   * Show a spinner while loading
   * @param isLoading {boolean}
   */
  function changeLoadingState(isLoading) {
    if (isLoading) {
      loading_spinner.removeClass('hidden');
    }
    else {
      loading_spinner.addClass('hidden');
    }
  }

  function getFilteredCdrIds() {
    var value = $('#cdrs').DataTable().columns( { search: 'applied' } ).data()[0];
    // Check if values were selected using the search  field.
    if (value != ",") {
    	return value;
    }
    else {
	    return '';
    }
  }

  function loadCDRDataTable(gwgroupid) {
    // Allow 0 = All Calls; only bail when nothing selected
    if (gwgroupid === null || gwgroupid === undefined || gwgroupid === '') {
      return;
    }

    changeLoadingState(true);

    // load CDR data
    if ($.fn.dataTable.isDataTable(cdr_table)) {
      cdr_table.ajax.url(API_BASE_URL + "cdrs/endpointgroups/" + gwgroupid);
      cdr_table.ajax.reload();
    }
    // datatable init
    else {
      cdr_table = $('#cdrs').DataTable({
        "pagingType": "full_numbers",
        "processing": false,
        "serverSide": true,
        "scrollX": true,
        "autoWidth": false,
        "ajax": {
          "url": API_BASE_URL + "cdrs/endpointgroups/" + gwgroupid,
          "data": function (d) {
            d.nonCompletedCalls = showallcalls_inp.val() === '1';
          },
          "dataFilter": function (data) {
            if (data) {
              var json = jQuery.parseJSON(data);
              json.recordsTotal = json.total_rows;
              json.recordsFiltered = json.filtered_rows;
              return JSON.stringify(json);
            }

            return JSON.stringify({
              data: [],
              recordsTotal: 0,
              recordsFiltered: 0
            });
          }
        },
        "columns": [
          {"data": "cdr_id", "orderable": false, "width": "70px"},
          {"data": "call_start_time", "width": "160px"},
          {"data": "call_duration", "width": "90px"},
          {"data": "call_direction", "width": "80px"},
          {"data": "src_gwgroupid", "visible": false, "searchable": false},
          {"data": "src_gwgroupname", "width": "160px"},
          {"data": "dst_gwgroupid", "visible": false, "searchable": false},
          {"data": "dst_gwgroupname", "width": "160px"},
          {"data": "src_username", "width": "140px"},
          {"data": "dst_username", "width": "140px"},
          {"data": "src_address", "width": "140px"},
          {"data": "dst_address", "width": "160px"},
          {"data": "hangup_reason", "width": "220px"},
          {"data": "call_id", "orderable": false, "width": "220px"}
        ],
        "order": [[1, 'desc']],
        "pageLength": 100,
        "searchDelay": 1000,
        "drawCallback": function () {
          // Keep header/body column alignment after horizontal scroll/resize
          this.api().columns.adjust();
        }
      });

      // Recalculate widths once the scroll container is ready
      setTimeout(function () {
        if (cdr_table) {
          cdr_table.columns.adjust();
        }
      }, 0);
      var searchbox = $(cdr_table.table().container()).find('input[type="search"]');
      var throttledEnter = throttledCallback(function(ev) {
        if (this.value === cdr_table.search()) {
          ev.preventDefault();
          return;
        }
        cdr_table.search(this.value).draw();
      }, 200);
      searchbox.on('keydown', function(ev) {
        if (ev.key === 'Enter') {
          throttledEnter.call(this, ev);
        }
      });
    }

    changeLoadingState(false);
  }

  $(document).ready(function () {
    // Ensure All Calls is present and selected by default
    if (epgroup_select.find("option[value='0']").length === 0) {
      epgroup_select.prepend("<option value='0' selected>All Calls</option>");
    } else {
      epgroup_select.val('0');
    }

    // Load endpoint + carrier groups into the filter
    $.ajax({
      type: "GET",
      url: API_BASE_URL + "cdrs/groups",
      dataType: "json",
      contentType: "application/json; charset=utf-8",
      success: function (response) {
        var rows = (response && response.data) ? response.data : [];
        for (var i = 0; i < rows.length; i++) {
          epgroup_select.append(
            "<option value='" + rows[i].gwgroupid + "'>" + rows[i].name + "</option>"
          );
        }
      },
      complete: function () {
        // Always load CDRs for the selected group (defaults to All Calls)
        loadCDRDataTable(epgroup_select.val() || '0');
      }
    });

    // default is enabled (bootstrap5-toggle auto-inits this visible checkbox on
    // window.load; set the checkbox state + fire change rather than calling the
    // removed jQuery .bootstrapToggle() plugin)
    showallcalls_inp.prop('checked', true).val(1).trigger('change');

    /* listener for completed calls toggle */
    showallcalls_inp.change(function() {
      var self = $(this);

      if (self.is(":checked") || self.prop("checked")) {
        self.val(1);
      }
      else {
        self.val(0);
      }
      loadCDRDataTable(epgroup_select.find('option:selected').val());
    });

    // change table when endpoint group selected
    epgroup_select.change(function () {
      loadCDRDataTable(epgroup_select.find('option:selected').val());
    });

    $('#downloadCDR').click(function () {
      var gwgroupid = $("#endpointgroups").val() || '0';
      var filtered = getFilteredCdrIds();
      var filterParam = Array.isArray(filtered) ? filtered.join(',') : (filtered || '');
      window.location.href = API_BASE_URL + 'cdrs/endpointgroups/' + gwgroupid + '?type=csv&filter=' + filterParam;
    });

    // reload table when the refresh button is clicked
    $('#refreshCDR').click(function () {
      loadCDRDataTable(epgroup_select.find('option:selected').val() || '0');
    });
  });

})(window, document);
