# Virtual sdcard support (print files directly from a host g-code file)
#
# Copyright (C) 2018-2024  Kevin O'Connor <kevin@koconnor.net>
#
# This file may be distributed under the terms of the GNU GPLv3 license.
import os, sys, logging, io, sqlite3

VALID_GCODE_EXTS = ['gcode', 'g', 'gco']

DEFAULT_ERROR_GCODE = """
{% if 'heaters' in printer %}
   TURN_OFF_HEATERS
{% endif %}
"""

class VirtualSD:
    def __init__(self, config):
        self.printer = config.get_printer()
        # sdcard state
        sd = config.get('path')
        self.sdcard_dirname = os.path.normpath(os.path.expanduser(sd))
        self.current_file = None
        self.current_file_path = None
        self.file_position = self.file_size = 0
        # Print Stat Tracking
        self.print_stats = self.printer.load_object(config, 'print_stats')
        self.screen_start_receipt = None
        self.preparing_screen_start = False
        self.pending_screen_start = None
        self.screen_start_serial = 0
        # Work timer
        self.reactor = self.printer.get_reactor()
        self.must_pause_work = self.cmd_from_sd = False
        self.next_file_position = 0
        self.work_timer = None
        # Error handling
        gcode_macro = self.printer.load_object(config, 'gcode_macro')
        aio = self.printer.load_object(config, 'aio_executor')
        self.executor = aio.allocate_executor("virtual_sdcard")
        self.on_error_gcode = gcode_macro.load_template(
            config, 'on_error_gcode', DEFAULT_ERROR_GCODE)
        if config.getboolean('screen_start_receipts', False):
            from .screen_start_receipt import ScreenStartReceipt
            self.screen_start_receipt = ScreenStartReceipt(
                config, self.sdcard_dirname)
            self.print_stats.screen_start_receipts = True
            self.printer.register_event_handler(
                "klippy:disconnect", self.screen_start_receipt.close)
        # Register commands
        self.gcode = self.printer.lookup_object('gcode')
        for cmd in ['M20', 'M21', 'M23', 'M24', 'M25', 'M26', 'M27']:
            self.gcode.register_command(cmd, getattr(self, 'cmd_' + cmd))
        for cmd in ['M28', 'M29', 'M30']:
            self.gcode.register_command(cmd, self.cmd_error)
        self.gcode.register_command(
            "SDCARD_RESET_FILE", self.cmd_SDCARD_RESET_FILE,
            desc=self.cmd_SDCARD_RESET_FILE_help)
        self.gcode.register_command(
            "SDCARD_PRINT_FILE", self.cmd_SDCARD_PRINT_FILE,
            desc=self.cmd_SDCARD_PRINT_FILE_help)
        self.standard_print_handler = self.gcode.ready_gcode_handlers[
            'SDCARD_PRINT_FILE']
        self.printer.register_event_handler("klippy:analyze_shutdown",
                                            self._handle_analyze_shutdown)
        self.printer.register_event_handler("gcode:debuginput_exit",
                                            self._handle_debuginput_exit)
    def _handle_analyze_shutdown(self, msg, details):
        if self.work_timer is None:
            return
        file_position = self.file_position
        current_file = self.current_file
        self.must_pause_work = True
        def log_debug_data(eventtime):
            try:
                readpos = max(file_position - 1024, 0)
                readcount = file_position - readpos
                current_file.seek(readpos)
                data = current_file.read(readcount + 128)
            except:
                logging.exception("virtual_sdcard shutdown read")
                return
            logging.info("Virtual sdcard (%d): %s\nUpcoming (%d): %s",
                         readpos, repr(data[:readcount]),
                         file_position, repr(data[readcount:]))
        self.reactor.register_callback(log_debug_data)
    def _handle_debuginput_exit(self):
        # When in batch debugging mode, wait until sdcard idle before exiting
        return self.work_timer is None
    def stats(self, eventtime):
        if self.work_timer is None:
            return False, ""
        return True, "sd_pos=%d" % (self.file_position,)
    def get_file_list(self, check_subdirs=False):
        if check_subdirs:
            flist = []
            for root, dirs, files in os.walk(
                    self.sdcard_dirname, followlinks=True):
                for name in files:
                    ext = name[name.rfind('.')+1:]
                    if ext not in VALID_GCODE_EXTS:
                        continue
                    full_path = os.path.join(root, name)
                    r_path = full_path[len(self.sdcard_dirname) + 1:]
                    size = os.path.getsize(full_path)
                    flist.append((r_path, size))
            return sorted(flist, key=lambda f: f[0].lower())
        else:
            dname = self.sdcard_dirname
            try:
                filenames = os.listdir(self.sdcard_dirname)
                return [(fname, os.path.getsize(os.path.join(dname, fname)))
                        for fname in sorted(filenames, key=str.lower)
                        if not fname.startswith('.')
                        and os.path.isfile((os.path.join(dname, fname)))]
            except:
                logging.exception("virtual_sdcard get_file_list")
                raise self.gcode.error("Unable to get file list")
    def get_status(self, eventtime):
        return {
            'file_path': self.file_path(),
            'progress': self.progress(),
            'is_active': self.is_active(),
            'file_position': self.file_position,
            'file_size': self.file_size,
        }
    def file_path(self):
        if self.current_file is not None:
            return self.current_file_path
        return None
    def progress(self):
        if self.file_size:
            return float(self.file_position) / self.file_size
        else:
            return 0.
    def is_active(self):
        return self.work_timer is not None
    def do_pause(self):
        self.invalidate_screen_start()
        if self.work_timer is not None:
            self.must_pause_work = True
            while self.work_timer is not None and not self.cmd_from_sd:
                self.reactor.pause(self.reactor.monotonic() + .001)
    def do_resume(self):
        if self.work_timer is not None:
            raise self.gcode.error("SD busy")
        self.invalidate_screen_start()
        self.must_pause_work = False
        self.work_timer = self.reactor.register_timer(
            self.work_handler, self.reactor.NOW)
    def do_cancel(self):
        self.invalidate_screen_start()
        if self.current_file is not None:
            self.do_pause()
        if self.current_file is not None:
            self.current_file.close()
            self.current_file = None
            self.print_stats.note_cancel()
        self.file_position = self.file_size = 0
    # G-Code commands
    def cmd_error(self, gcmd):
        raise gcmd.error("SD write not supported")
    def _reset_file(self):
        self.invalidate_screen_start()
        if self.current_file is not None:
            self.do_pause()
        if self.current_file is not None:
            self.current_file.close()
            self.current_file = None
        self.pending_screen_start = None
        self.file_position = self.file_size = 0
        self.print_stats.reset()
        self.printer.send_event("virtual_sdcard:reset_file")
    cmd_SDCARD_RESET_FILE_help = "Clears a loaded SD File. Stops the print "\
        "if necessary"
    def cmd_SDCARD_RESET_FILE(self, gcmd):
        if self.cmd_from_sd:
            raise gcmd.error(
                "SDCARD_RESET_FILE cannot be run from the sdcard")
        self._reset_file()
    cmd_SDCARD_PRINT_FILE_help = "Loads a SD file and starts the print.  May "\
        "include files in subdirectories."
    def cmd_SDCARD_PRINT_FILE(self, gcmd):
        if self.work_timer is not None:
            raise gcmd.error("SD busy")
        self._reset_file()
        filename = gcmd.get("FILENAME")
        if filename[0] == '/':
            filename = filename[1:]
        self._load_file(gcmd, filename, check_subdirs=True)
        self.do_resume()
    def _check_screen_start_ready(self):
        command = self.gcode.gcode_handlers.get('SDCARD_PRINT_FILE')
        if (not self.gcode.is_printer_ready
                or command is not self.standard_print_handler):
            raise self.gcode.error("Screen start requires standard virtual SD")
        if self.work_timer is not None:
            raise self.gcode.error("SD busy")
    def invalidate_screen_start(self):
        self.screen_start_serial += 1
    def start_with_screen_intent(self, intent):
        if self.screen_start_receipt is None:
            raise self.gcode.error("Screen start receipts are disabled")
        self._check_screen_start_ready()
        if self.preparing_screen_start:
            raise self.gcode.error("Screen start already in progress")
        serial = self.screen_start_serial
        self.preparing_screen_start = True
        snapshot = None
        try:
            snapshot, size = self.executor.submit(
                self.screen_start_receipt.prepare, intent, VALID_GCODE_EXTS)
            filename = intent['filename']
            with self.gcode.get_mutex():
                self._check_screen_start_ready()
                if serial != self.screen_start_serial:
                    raise self.gcode.error("Virtual SD changed during start")
                self.screen_start_receipt.check_expiry(intent)
                selected_file = io.TextIOWrapper(
                    io.BufferedReader(self.executor.wrap_obj(snapshot)),
                    encoding='utf-8', newline='')
                self._reset_file()
                self._check_screen_start_ready()
                gcmd = self.gcode.create_gcode_command(
                    'SDCARD_PRINT_FILE', 'SDCARD_PRINT_FILE', {})
                self._select_file(gcmd, filename,
                                  os.path.join(self.sdcard_dirname, filename),
                                  selected_file, size)
                snapshot = None
                self.pending_screen_start = intent
                self.do_resume()
        except (ValueError, OSError, sqlite3.Error):
            raise self.gcode.error("Screen start intent or file rejected")
        finally:
            if snapshot is not None:
                self.executor.submit(snapshot.close)
            self.preparing_screen_start = False
    def cmd_M20(self, gcmd):
        # List SD card
        files = self.get_file_list()
        gcmd.respond_raw("Begin file list")
        for fname, fsize in files:
            gcmd.respond_raw("%s %d" % (fname, fsize))
        gcmd.respond_raw("End file list")
    def cmd_M21(self, gcmd):
        # Initialize SD card
        gcmd.respond_raw("SD card ok")
    def cmd_M23(self, gcmd):
        # Select SD file
        if self.work_timer is not None:
            raise gcmd.error("SD busy")
        self._reset_file()
        filename = gcmd.get_raw_command_parameters().strip()
        if filename.startswith('/'):
            filename = filename[1:]
        self._load_file(gcmd, filename)
    def _load_file(self, gcmd, filename, check_subdirs=False):
        files = self.get_file_list(check_subdirs)
        flist = [f[0] for f in files]
        files_by_lower = { fname.lower(): fname for fname, fsize in files }
        fname = filename
        try:
            if fname not in flist:
                fname = files_by_lower[fname.lower()]
            fname = os.path.join(self.sdcard_dirname, fname)
            f = self.executor.submit(io.open, fname, 'rb', buffering=0)
            f = self.executor.wrap_obj(f)
            f = io.BufferedReader(f)
            f.seek(0, os.SEEK_END)
            fsize = f.tell()
            f.seek(0)
            f = io.TextIOWrapper(f, newline='')
        except:
            logging.exception("virtual_sdcard file open")
            raise gcmd.error("Unable to open file")
        self._select_file(gcmd, filename, fname, f, fsize)
    def _select_file(self, gcmd, filename, path, f, fsize):
        gcmd.respond_raw("File opened:%s Size:%d" % (filename, fsize))
        gcmd.respond_raw("File selected")
        self.current_file = f
        self.current_file_path = path
        self.file_position = 0
        self.file_size = fsize
        self.print_stats.set_current_file(filename)
    def cmd_M24(self, gcmd):
        # Start/resume SD print
        self.do_resume()
    def cmd_M25(self, gcmd):
        # Pause SD print
        self.do_pause()
    def cmd_M26(self, gcmd):
        # Set SD position
        if self.work_timer is not None:
            raise gcmd.error("SD busy")
        pos = gcmd.get_int('S', minval=0)
        self.invalidate_screen_start()
        self.file_position = pos
    def cmd_M27(self, gcmd):
        # Report SD print status
        if self.current_file is None:
            gcmd.respond_raw("Not SD printing.")
            return
        gcmd.respond_raw("SD printing byte %d/%d"
                         % (self.file_position, self.file_size))
    def get_file_position(self):
        return self.next_file_position
    def set_file_position(self, pos):
        self.next_file_position = pos
    def is_cmd_from_sd(self):
        return self.cmd_from_sd
    # Background work timer
    def _discard_screen_start(self):
        snapshot = self.current_file
        self.current_file = self.current_file_path = None
        self.file_position = self.file_size = 0
        self.work_timer = None
        snapshot.close()
    def work_handler(self, eventtime):
        logging.info("Starting SD card print (position %d)", self.file_position)
        self.reactor.unregister_timer(self.work_timer)
        intent = self.pending_screen_start
        self.pending_screen_start = None
        try:
            self.current_file.seek(self.file_position)
        except:
            logging.exception("virtual_sdcard seek")
            if intent is None:
                self.work_timer = None
            else:
                self._discard_screen_start()
            return self.reactor.NEVER
        if intent is not None:
            try:
                self.screen_start_receipt.check_expiry(intent)
            except ValueError:
                self._discard_screen_start()
                return self.reactor.NEVER
            if self.must_pause_work or not self.gcode.is_printer_ready:
                self._discard_screen_start()
                return self.reactor.NEVER
            # Let existing subscriptions observe the real selected-file state
            # before entering printing, even between periodic status samples.
            self.printer.send_event("virtual_sdcard:screen_status_changed")
        self.print_stats.note_start()
        if intent is not None:
            try:
                self.print_stats.screen_start_receipt = \
                    self.screen_start_receipt.issue(intent)
            except Exception:
                logging.exception("Unable to sign screen start receipt")
                self.print_stats.note_error("Unable to sign screen start")
                self._discard_screen_start()
                return self.reactor.NEVER
            self.printer.send_event("virtual_sdcard:screen_status_changed")
        gcode_mutex = self.gcode.get_mutex()
        partial_input = ""
        lines = []
        error_message = None
        while not self.must_pause_work:
            if not lines:
                # Read more data
                try:
                    data = self.current_file.read(8192)
                except:
                    logging.exception("virtual_sdcard read")
                    break
                if not data:
                    # End of file
                    self.current_file.close()
                    self.current_file = None
                    logging.info("Finished SD card print")
                    self.gcode.respond_raw("Done printing file")
                    break
                lines = data.split('\n')
                lines[0] = partial_input + lines[0]
                partial_input = lines.pop()
                lines.reverse()
                self.reactor.pause(self.reactor.NOW)
                continue
            # Pause if any other request is pending in the gcode class
            if gcode_mutex.test():
                self.reactor.pause(self.reactor.monotonic() + 0.050)
                continue
            # Dispatch command
            self.cmd_from_sd = True
            line = lines.pop()
            if sys.version_info.major >= 3:
                next_file_position = self.file_position + len(line.encode()) + 1
            else:
                next_file_position = self.file_position + len(line) + 1
            self.next_file_position = next_file_position
            try:
                self.gcode.run_script(line)
            except self.gcode.error as e:
                error_message = str(e)
                try:
                    self.gcode.run_script(self.on_error_gcode.render())
                except:
                    logging.exception("virtual_sdcard on_error")
                break
            except:
                logging.exception("virtual_sdcard dispatch")
                break
            self.cmd_from_sd = False
            self.file_position = self.next_file_position
            # Do we need to skip around?
            if self.next_file_position != next_file_position:
                try:
                    self.current_file.seek(self.file_position)
                except:
                    logging.exception("virtual_sdcard seek")
                    self.work_timer = None
                    return self.reactor.NEVER
                lines = []
                partial_input = ""
        logging.info("Exiting SD card print (position %d)", self.file_position)
        self.work_timer = None
        self.cmd_from_sd = False
        if error_message is not None:
            self.print_stats.note_error(error_message)
        elif self.current_file is not None:
            self.print_stats.note_pause()
        else:
            self.print_stats.note_complete()
        if intent is not None:
            self.printer.send_event("virtual_sdcard:screen_status_changed")
        return self.reactor.NEVER

def load_config(config):
    return VirtualSD(config)
