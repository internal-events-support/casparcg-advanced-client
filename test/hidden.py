"""Run a command on a separate, invisible Windows desktop so test windows never touch the screen.
usage: hidden.py <seconds> <command...>"""
import ctypes, subprocess, sys
from ctypes import wintypes as w
k, u = ctypes.WinDLL('kernel32', use_last_error=True), ctypes.WinDLL('user32', use_last_error=True)
class SI(ctypes.Structure):
    _fields_ = [('cb', w.DWORD), ('r', w.LPWSTR), ('desk', w.LPWSTR), ('title', w.LPWSTR)] + [(n, w.DWORD) for n in 'x y xs ys xc yc fill flags'.split()] + [('show', w.WORD), ('cb2', w.WORD), ('r2', ctypes.c_void_p), ('i', w.HANDLE), ('o', w.HANDLE), ('e', w.HANDLE)]
class PI(ctypes.Structure):
    _fields_ = [('p', w.HANDLE), ('t', w.HANDLE), ('pid', w.DWORD), ('tid', w.DWORD)]
u.CreateDesktopW.restype = ctypes.c_void_p
d = u.CreateDesktopW('vttest', None, None, 0, 0x10000000, None)
if not d: sys.exit('no desktop %s' % ctypes.get_last_error())
si = SI(); si.cb = ctypes.sizeof(SI); si.desk = 'winsta0\\vttest'; pi = PI()
cmd = ctypes.create_unicode_buffer(subprocess.list2cmdline(sys.argv[2:]))
if not k.CreateProcessW(None, cmd, None, None, False, 0x08000000, None, None, ctypes.byref(si), ctypes.byref(pi)): sys.exit('start failed %s' % ctypes.get_last_error())
if k.WaitForSingleObject(w.HANDLE(pi.p), int(sys.argv[1]) * 1000): k.TerminateProcess(w.HANDLE(pi.p), 1); print('timed out')
u.CloseDesktop(ctypes.c_void_p(d))
