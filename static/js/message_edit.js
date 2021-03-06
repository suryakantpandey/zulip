var render_message_edit_form = require('../templates/message_edit_form.hbs');
var render_message_edit_history = require('../templates/message_edit_history.hbs');
var render_topic_edit_form = require('../templates/topic_edit_form.hbs');

var message_edit = (function () {
var exports = {};
var currently_editing_messages = {};
var currently_deleting_messages = [];

var editability_types = {
    NO: 1,
    NO_LONGER: 2,
    // Note: TOPIC_ONLY does not include stream messages with no topic sent
    // by someone else. You can edit the topic of such a message by editing
    // the topic of the whole recipient_row it appears in, but you can't
    // directly edit the topic of such a message.
    // Similar story for messages whose topic you can change only because
    // you are an admin.
    TOPIC_ONLY: 3,
    FULL: 4,
};
exports.editability_types = editability_types;

function is_topic_editable(message, edit_limit_seconds_buffer) {
    var now = new XDate();
    edit_limit_seconds_buffer = edit_limit_seconds_buffer || 0;

    if (!page_params.realm_allow_message_editing) {
        // If message editing is disabled, so is topic editing.
        return false;
    }
    // Organization admins and message senders can edit message topics indefinitely.
    if (page_params.is_admin) {
        return true;
    }
    if (message.sent_by_me) {
        return true;
    }

    if (!page_params.realm_allow_community_topic_editing) {
        // If you're another non-admin user, you need community topic editing enabled.
        return false;
    }

    // If you're using community topic editing, there's a deadline.
    // TODO: Change hardcoded value (24 hrs) to be realm setting.  Currently, it is
    // DEFAULT_COMMUNITY_TOPIC_EDITING_LIMIT_SECONDS
    return 86400 + edit_limit_seconds_buffer + now.diffSeconds(message.timestamp * 1000) > 0;
}

function get_editability(message, edit_limit_seconds_buffer) {
    edit_limit_seconds_buffer = edit_limit_seconds_buffer || 0;
    if (!message) {
        return editability_types.NO;
    }
    if (!is_topic_editable(message, edit_limit_seconds_buffer)) {
        return editability_types.NO;
    }
    if (message.failed_request) {
        // TODO: For completely failed requests, we should be able
        //       to "edit" the message, but it won't really be like
        //       other message updates.  This commit changed the result
        //       from FULL to NO, since the prior implementation was
        //       buggy.
        return editability_types.NO;
    }

    // Locally echoed messages are not editable, since the message hasn't
    // finished being sent yet.
    if (message.locally_echoed) {
        return editability_types.NO;
    }

    if (!page_params.realm_allow_message_editing) {
        return editability_types.NO;
    }

    if (page_params.realm_message_content_edit_limit_seconds === 0 && message.sent_by_me) {
        return editability_types.FULL;
    }

    var now = new XDate();
    if (page_params.realm_message_content_edit_limit_seconds + edit_limit_seconds_buffer +
        now.diffSeconds(message.timestamp * 1000) > 0 && message.sent_by_me) {
        return editability_types.FULL;
    }

    // time's up!
    if (message.type === 'stream') {
        return editability_types.TOPIC_ONLY;
    }
    return editability_types.NO_LONGER;
}
exports.get_editability = get_editability;
exports.is_topic_editable = is_topic_editable;

exports.get_deletability = function (message) {
    if (page_params.is_admin) {
        return true;
    }

    if (!message.sent_by_me) {
        return false;
    }
    if (message.locally_echoed) {
        return false;
    }
    if (!page_params.realm_allow_message_deleting) {
        return false;
    }

    if (page_params.realm_message_content_delete_limit_seconds === 0) {
        // This means no time limit for message deletion.
        return true;
    }

    if (page_params.realm_allow_message_deleting) {
        var now = new XDate();
        if (page_params.realm_message_content_delete_limit_seconds +
            now.diffSeconds(message.timestamp * 1000) > 0) {
            return true;
        }
    }
    return false;
};

// Returns true if the edit task should end.
exports.save = function (row, from_topic_edited_only) {
    var msg_list = current_msg_list;
    var message_id;

    if (row.hasClass('recipient_row')) {
        message_id = rows.id_for_recipient_row(row);
    } else {
        message_id = rows.id(row);
    }
    var message = current_msg_list.get(message_id);
    var changed = false;

    var new_content = row.find(".message_edit_content").val();
    var topic_changed = false;
    var new_topic;
    var old_topic = util.get_message_topic(message);

    if (message.type === "stream") {
        if (from_topic_edited_only) {
            new_topic = row.find(".inline_topic_edit").val();
        } else {
            new_topic = row.find(".message_edit_topic").val();
        }
        topic_changed = new_topic !== old_topic && new_topic.trim() !== "";
    }
    // Editing a not-yet-acked message (because the original send attempt failed)
    // just results in the in-memory message being changed
    if (message.locally_echoed) {
        if (new_content !== message.raw_content || topic_changed) {
            echo.edit_locally(message, new_content, topic_changed ? new_topic : undefined);
            row = current_msg_list.get_row(message_id);
        }
        message_edit.end(row);
        return;
    }

    var request = {message_id: message.id};
    if (topic_changed) {
        util.set_message_topic(request, new_topic);
        if (feature_flags.propagate_topic_edits) {
            var selected_topic_propagation = row.find("select.message_edit_topic_propagate").val() || "change_later";
            request.propagate_mode = selected_topic_propagation;
        }
        changed = true;
    }

    if (new_content !== message.raw_content && !from_topic_edited_only) {
        request.content = new_content;
        changed = true;
    }
    if (!changed) {
        // If they didn't change anything, just cancel it.
        message_edit.end(row);
        return;
    }
    channel.patch({
        url: '/json/messages/' + message.id,
        data: request,
        success: function () {
            var spinner = row.find(".topic_edit_spinner");
            loading.destroy_indicator(spinner);
        },
        error: function (xhr) {
            if (msg_list === current_msg_list) {
                var message = channel.xhr_error_message(i18n.t("Error saving edit"), xhr);
                row.find(".edit_error").text(message).show();
            }
        },
    });
    // The message will automatically get replaced via message_list.update_message.
};

exports.update_message_topic_editing_pencil = function () {
    if (page_params.realm_allow_message_editing) {
        $(".on_hover_topic_edit, .always_visible_topic_edit").show();
    } else {
        $(".on_hover_topic_edit, .always_visible_topic_edit").hide();
    }
};

exports.show_topic_edit_spinner = function (row) {
    var spinner = row.find(".topic_edit_spinner");
    loading.make_indicator(spinner);
    $(spinner).removeAttr("style");
    $(".topic_edit_save").hide();
    $(".topic_edit_cancel").hide();
};

function handle_edit_keydown(from_topic_edited_only, e) {
    var row;
    var code = e.keyCode || e.which;

    if ($(e.target).hasClass("message_edit_content") && code === 13) {
        // Pressing enter to save edits is coupled with enter to send
        if (composebox_typeahead.should_enter_send(e)) {
            row = $(".message_edit_content").filter(":focus").closest(".message_row");
            var message_edit_save_button = row.find(".message_edit_save");
            if (message_edit_save_button.attr('disabled') === "disabled") {
                // In cases when the save button is disabled
                // we need to disable save on pressing enter
                // Prevent default to avoid new-line on pressing
                // enter inside the textarea in this case
                e.preventDefault();
                return;
            }
        } else {
            composebox_typeahead.handle_enter($(e.target), e);
            return;
        }
    } else if (code === 13 && ($(e.target).hasClass("message_edit_topic") ||
                               $(e.target).hasClass("message_edit_topic_propagate"))) {
        row = $(e.target).closest(".message_row");
    } else if (e.target.id === "inline_topic_edit" && code === 13) {
        row = $(e.target).closest(".recipient_row");
        exports.show_topic_edit_spinner(row);
    } else {
        return;
    }
    e.stopPropagation();
    e.preventDefault();
    message_edit.save(row, from_topic_edited_only);
}

function timer_text(seconds_left) {
    var minutes = Math.floor(seconds_left / 60);
    var seconds = seconds_left % 60;
    if (minutes >= 1) {
        return i18n.t("__minutes__ min to edit", {minutes: minutes.toString()});
    } else if (seconds_left >= 10) {
        return i18n.t("__seconds__ sec to edit", {seconds: (seconds - seconds % 5).toString()});
    }
    return i18n.t("__seconds__ sec to edit", {seconds: seconds.toString()});
}

function edit_message(row, raw_content) {
    row.find(".message_reactions").hide();
    condense.hide_message_expander(row);
    var content_top = row.find('.message_top_line')[0]
        .getBoundingClientRect().top;

    var message = current_msg_list.get(rows.id(row));

    // We potentially got to this function by clicking a button that implied the
    // user would be able to edit their message.  Give a little bit of buffer in
    // case the button has been around for a bit, e.g. we show the
    // edit_content_button (hovering pencil icon) as long as the user would have
    // been able to click it at the time the mouse entered the message_row. Also
    // a buffer in case their computer is slow, or stalled for a second, etc
    // If you change this number also change edit_limit_buffer in
    // zerver.views.messages.update_message_backend
    var seconds_left_buffer = 5;
    var editability = get_editability(message, seconds_left_buffer);
    var is_editable = editability === message_edit.editability_types.TOPIC_ONLY ||
                       editability === message_edit.editability_types.FULL;
    var max_file_upload_size = page_params.max_file_upload_size;
    var file_upload_enabled = false;

    if (max_file_upload_size > 0) {
        file_upload_enabled = true;
    }

    var form = $(render_message_edit_form({
        is_stream: message.type === 'stream',
        message_id: message.id,
        is_editable: is_editable,
        is_content_editable: editability === message_edit.editability_types.FULL,
        has_been_editable: editability !== editability_types.NO,
        topic: util.get_message_topic(message),
        content: raw_content,
        file_upload_enabled: file_upload_enabled,
        minutes_to_edit: Math.floor(page_params.realm_message_content_edit_limit_seconds / 60),
    }));

    var edit_obj = {form: form, raw_content: raw_content};
    currently_editing_messages[message.id] = edit_obj;
    current_msg_list.show_edit_message(row, edit_obj);

    form.keydown(_.partial(handle_edit_keydown, false));

    upload.feature_check($('#attach_files_' + rows.id(row)));

    var message_edit_content = row.find('textarea.message_edit_content');
    var message_edit_topic = row.find('input.message_edit_topic');
    var message_edit_topic_propagate = row.find('select.message_edit_topic_propagate');
    var message_edit_countdown_timer = row.find('.message_edit_countdown_timer');
    var copy_message = row.find('.copy_message');

    if (editability === editability_types.NO) {
        message_edit_content.prop("readonly", "readonly");
        message_edit_topic.prop("readonly", "readonly");
        new ClipboardJS(copy_message[0]);
    } else if (editability === editability_types.NO_LONGER) {
        // You can currently only reach this state in non-streams. If that
        // changes (e.g. if we stop allowing topics to be modified forever
        // in streams), then we'll need to disable
        // row.find('input.message_edit_topic') as well.
        message_edit_content.prop("readonly", "readonly");
        message_edit_countdown_timer.text(i18n.t("View source"));
        new ClipboardJS(copy_message[0]);
    } else if (editability === editability_types.TOPIC_ONLY) {
        message_edit_content.prop("readonly", "readonly");
        // Hint why you can edit the topic but not the message content
        message_edit_countdown_timer.text(i18n.t("Topic editing only"));
        new ClipboardJS(copy_message[0]);
    } else if (editability === editability_types.FULL) {
        copy_message.remove();
        var edit_id = "#message_edit_content_" + rows.id(row);
        var listeners = resize.watch_manual_resize(edit_id);
        if (listeners) {
            currently_editing_messages[rows.id(row)].listeners = listeners;
        }
        composebox_typeahead.initialize_compose_typeahead(edit_id);
        compose.handle_keyup(null, $(edit_id).expectOne());
        $(edit_id).on('keydown', function (event) {
            compose.handle_keydown(event, $(this).expectOne());
        });
        $(edit_id).on('keyup', function (event) {
            compose.handle_keyup(event, $(this).expectOne());
        });
    }

    // Add tooltip
    if (editability !== editability_types.NO &&
        page_params.realm_message_content_edit_limit_seconds > 0) {
        row.find('.message-edit-timer-control-group').show();
        row.find('#message_edit_tooltip').tooltip({
            animation: false,
            placement: 'left',
            template: '<div class="tooltip" role="tooltip"><div class="tooltip-arrow"></div>' +
                '<div class="tooltip-inner message-edit-tooltip-inner"></div></div>',
        });
    }

    // add timer
    if (editability === editability_types.FULL &&
        page_params.realm_message_content_edit_limit_seconds > 0) {
        // Give them at least 10 seconds.
        // If you change this number also change edit_limit_buffer in
        // zerver.views.messages.update_message_backend
        var min_seconds_to_edit = 10;
        var now = new XDate();
        var seconds_left = page_params.realm_message_content_edit_limit_seconds +
            now.diffSeconds(message.timestamp * 1000);
        seconds_left = Math.floor(Math.max(seconds_left, min_seconds_to_edit));

        // I believe this needs to be defined outside the countdown_timer, since
        // row just refers to something like the currently selected message, and
        // can change out from under us
        var message_edit_save = row.find('button.message_edit_save');
        // Do this right away, rather than waiting for the timer to do its first update,
        // since otherwise there is a noticeable lag
        message_edit_countdown_timer.text(timer_text(seconds_left));
        var countdown_timer = setInterval(function () {
            seconds_left -= 1;
            if (seconds_left <= 0) {
                clearInterval(countdown_timer);
                message_edit_content.prop("readonly", "readonly");
                if (message.type === 'stream') {
                    message_edit_topic.prop("readonly", "readonly");
                    message_edit_topic_propagate.hide();
                }
                // We don't go directly to a "TOPIC_ONLY" type state (with an active Save button),
                // since it isn't clear what to do with the half-finished edit. It's nice to keep
                // the half-finished edit around so that they can copy-paste it, but we don't want
                // people to think "Save" will save the half-finished edit.
                message_edit_save.addClass("disabled");
                message_edit_countdown_timer.text(i18n.t("Time's up!"));
            } else {
                message_edit_countdown_timer.text(timer_text(seconds_left));
            }
        }, 1000);
    }

    if (!is_editable) {
        row.find(".message_edit_close").focus();
    } else if (message.type === 'stream' && util.get_message_topic(message) === compose.empty_topic_placeholder()) {
        message_edit_topic.val('');
        message_edit_topic.focus();
    } else if (editability === editability_types.TOPIC_ONLY) {
        row.find(".message_edit_topic").focus();
    } else {
        message_edit_content.focus();
        // Put cursor at end of input.
        var contents = message_edit_content.val();
        message_edit_content.val('');
        message_edit_content.val(contents);
    }

    // Scroll to keep the top of the message content text in the same
    // place visually, adjusting for border and padding.
    var edit_top = message_edit_content[0].getBoundingClientRect().top;
    var scroll_by = edit_top - content_top + 5 - 14;

    edit_obj.scrolled_by = scroll_by;
    message_viewport.scrollTop(message_viewport.scrollTop() + scroll_by);

    if (feature_flags.propagate_topic_edits && !message.locally_echoed) {
        var original_topic = util.get_message_topic(message);
        message_edit_topic.keyup(function () {
            var new_topic = message_edit_topic.val();
            message_edit_topic_propagate.toggle(new_topic !== original_topic && new_topic !== "");
        });
    }
}

function start_edit_maintaining_scroll(row, content) {
    edit_message(row, content);
    var row_bottom = row.height() + row.offset().top;
    var composebox_top = $("#compose").offset().top;
    if (row_bottom > composebox_top) {
        message_viewport.scrollTop(message_viewport.scrollTop() + row_bottom - composebox_top);
    }
}

function start_edit_with_content(row, content, edit_box_open_callback) {
    start_edit_maintaining_scroll(row, content);
    if (edit_box_open_callback) {
        edit_box_open_callback();
    }

    row.find('#message_edit_form').filedrop(
        upload.options({
            mode: 'edit',
            row: rows.id(row),
        })
    );
}

exports.start = function (row, edit_box_open_callback) {
    var message = current_msg_list.get(rows.id(row));
    if (message === undefined) {
        blueslip.error("Couldn't find message ID for edit " + rows.id(row));
        return;
    }

    if (message.raw_content) {
        start_edit_with_content(row, message.raw_content, edit_box_open_callback);
        return;
    }

    var msg_list = current_msg_list;
    channel.get({
        url: '/json/messages/' + message.id,
        idempotent: true,
        success: function (data) {
            if (current_msg_list === msg_list) {
                message.raw_content = data.raw_content;
                start_edit_with_content(row, message.raw_content, edit_box_open_callback);
            }
        },
    });
};

exports.start_topic_edit = function (recipient_row) {
    var form = $(render_topic_edit_form());
    current_msg_list.show_edit_topic(recipient_row, form);
    form.keydown(_.partial(handle_edit_keydown, true));
    var msg_id = rows.id_for_recipient_row(recipient_row);
    var message = current_msg_list.get(msg_id);
    var topic = util.get_message_topic(message);
    if (topic === compose.empty_topic_placeholder()) {
        topic = '';
    }
    form.find(".inline_topic_edit").val(topic).select().focus();
};

exports.is_editing = function (id) {
    return currently_editing_messages[id] !== undefined;
};

exports.end = function (row) {
    var message = current_msg_list.get(rows.id(row));
    if (message !== undefined &&
        currently_editing_messages[message.id] !== undefined) {
        var scroll_by = currently_editing_messages[message.id].scrolled_by;
        message_viewport.scrollTop(message_viewport.scrollTop() - scroll_by);

        // Clean up resize event listeners
        var listeners = currently_editing_messages[message.id].listeners;
        var edit_box = document.querySelector("#message_edit_content_" + message.id);
        if (listeners !== undefined) {
            // Event listeners to cleanup are only set in some edit types
            edit_box.removeEventListener("mousedown", listeners[0]);
            document.body.removeEventListener("mouseup", listeners[1]);
        }

        delete currently_editing_messages[message.id];
        current_msg_list.hide_edit_message(row);
    }
    if (row !== undefined) {
        current_msg_list.hide_edit_topic(row);
    }
    condense.show_message_expander(row);
    row.find(".message_reactions").show();

    // We have to blur out text fields, or else hotkeys.js
    // thinks we are still editing.
    row.find(".message_edit").blur();
};

exports.maybe_show_edit = function (row, id) {
    if (currently_editing_messages[id] !== undefined) {
        current_msg_list.show_edit_message(row, currently_editing_messages[id]);
    }
};

exports.edit_last_sent_message = function () {
    var msg = current_msg_list.get_last_message_sent_by_me();

    if (!msg) {
        return;
    }

    if (!msg.id) {
        blueslip.error('Message has invalid id in edit_last_sent_message.');
        return;
    }

    var msg_editability_type = exports.get_editability(msg, 5);
    if (msg_editability_type !== editability_types.FULL) {
        return;
    }

    var msg_row = current_msg_list.get_row(msg.id);
    if (!msg_row) {
        // This should never happen, since we got the message above
        // from current_msg_list.
        blueslip.error('Could not find row for id ' + msg.id);
        return;
    }

    current_msg_list.select_id(msg.id, {then_scroll: true, from_scroll: true});

    // Finally do the real work!
    compose_actions.cancel();
    message_edit.start(msg_row, function () {
        $('#message_edit_content').focus();
    });
};

exports.show_history = function (message) {
    $('#message-history').html('');
    $('#message-edit-history').modal("show");
    channel.get({
        url: "/json/messages/" + message.id + "/history",
        data: {message_id: JSON.stringify(message.id)},
        success: function (data) {
            var content_edit_history = [];
            var prev_timestamp;
            _.each(data.message_history, function (msg, index) {
                // Format timestamp nicely for display
                var timestamp = timerender.get_full_time(msg.timestamp);
                var item = {
                    timestamp: moment(timestamp).format("h:mm A"),
                    display_date: moment(timestamp).format("MMMM D, YYYY"),
                };
                if (msg.user_id) {
                    var person = people.get_person_from_user_id(msg.user_id);
                    item.edited_by = person.full_name;
                }

                if (index === 0) {
                    item.posted_or_edited = "Posted by";
                    item.body_to_render = msg.rendered_content;
                    prev_timestamp = timestamp;
                    item.show_date_row = true;
                } else if (msg.prev_topic && msg.prev_content) {
                    item.posted_or_edited = "Edited by";
                    item.body_to_render = msg.content_html_diff;
                    item.show_date_row = !moment(timestamp).isSame(prev_timestamp, 'day');
                    item.topic_edited = true;
                    item.prev_topic = msg.prev_topic;
                    item.new_topic = msg.topic;
                } else if (msg.prev_topic) {
                    item.posted_or_edited = "Topic edited by";
                    item.topic_edited = true;
                    item.prev_topic = msg.prev_topic;
                    item.new_topic = msg.topic;
                } else {
                    // just a content edit
                    item.posted_or_edited = "Edited by";
                    item.body_to_render = msg.content_html_diff;
                    item.show_date_row = !moment(timestamp).isSame(prev_timestamp, 'day');
                }

                content_edit_history.push(item);
            });

            $('#message-history').html(render_message_edit_history({
                edited_messages: content_edit_history,
            }));
        },
        error: function (xhr) {
            ui_report.error(i18n.t("Error fetching message edit history"), xhr,
                            $("#message-history-error"));
        },
    });
};

function hide_delete_btn_show_spinner(deleting) {
    if (deleting) {
        $('do_delete_message_button').attr('disabled', 'disabled');
        $('#delete_message_modal > div.modal-footer > button').hide();
        var delete_spinner = $("#do_delete_message_spinner");
        loading.make_indicator(delete_spinner, { abs_positioned: true });
    } else {
        loading.destroy_indicator($("#do_delete_message_spinner"));
        $("#do_delete_message_button").prop('disabled', false);
        $('#delete_message_modal > div.modal-footer > button').show();
    }
}

exports.delete_message = function (msg_id) {
    $("#delete-message-error").html('');
    $('#delete_message_modal').modal("show");
    if (_.contains(currently_deleting_messages, msg_id)) {
        hide_delete_btn_show_spinner(true);
    } else {
        hide_delete_btn_show_spinner(false);
    }
    $('#do_delete_message_button').off().on('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        currently_deleting_messages.push(msg_id);
        hide_delete_btn_show_spinner(true);
        channel.del({
            url: "/json/messages/" + msg_id,
            success: function () {
                $('#delete_message_modal').modal("hide");
                currently_deleting_messages = _.reject(currently_deleting_messages, function (id) {
                    return id === msg_id;
                });
                hide_delete_btn_show_spinner(false);
            },
            error: function (xhr) {
                currently_deleting_messages = _.reject(currently_deleting_messages, function (id) {
                    return id === msg_id;
                });
                hide_delete_btn_show_spinner(false);
                ui_report.error(i18n.t("Error deleting message"), xhr,
                                $("#delete-message-error"));
            },
        });

    });
};

exports.delete_topic = function (stream_id, topic_name) {
    channel.post({
        url: "/json/streams/" + stream_id + "/delete_topic",
        data: {
            topic_name: topic_name,
        },
        success: function () {
            $('#delete_topic_modal').modal('hide');
        },
    });
};

exports.handle_narrow_deactivated = function () {
    _.each(currently_editing_messages, function (elem, idx) {
        if (current_msg_list.get(idx) !== undefined) {
            var row = current_msg_list.get_row(idx);
            current_msg_list.show_edit_message(row, elem);
        }
    });
};

return exports;
}());

if (typeof module !== 'undefined') {
    module.exports = message_edit;
}
window.message_edit = message_edit;
