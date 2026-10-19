// dirfd_ops.cc — N-API thin wrappers around POSIX *at() syscalls.
//
// Why this exists: Node's fs APIs are path-based. A path-based open()
// or rename() resolves the parent directory at the syscall moment, so
// any attacker who can swap a parent directory between our anchor
// check and the actual op wins the race. Per CLAUDE.md §4 round-12
// Codex review: that residual race window cannot be closed at the JS
// layer — the kernel needs us to bind to the parent inode through a
// file descriptor (openat/renameat/etc).
//
// Surface: 6 raw syscalls. Errno on failure → JS Error with .errno
// (number) and .syscall (string) so caller can do errno checks.
//
// Lifecycle: this addon does NOT track or own fds. The caller (JS) is
// responsible for closing every fd it opens — we expose `closeFd` for
// fds returned by openat. Parent dirfds are typically opened via
// Node's fs.open(parentDir, O_DIRECTORY|O_NOFOLLOW) and closed via the
// FileHandle.close() API; we never see those.

#include <napi.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <dirent.h>
#include <errno.h>
#include <string.h>
#include <string>

namespace {

// Map a POSIX errno number to its stable symbolic name (matches Node's
// fs error .code values). JS callers check `err.code === 'ELOOP'` etc;
// using a portable name avoids platform errno-number drift (e.g. ELOOP
// is 62 on macOS but 40 on Linux).
const char* ErrnoToName(int e) {
  switch (e) {
    case EPERM: return "EPERM";
    case ENOENT: return "ENOENT";
    case ESRCH: return "ESRCH";
    case EINTR: return "EINTR";
    case EIO: return "EIO";
    case ENXIO: return "ENXIO";
    case E2BIG: return "E2BIG";
    case ENOEXEC: return "ENOEXEC";
    case EBADF: return "EBADF";
    case ECHILD: return "ECHILD";
    case EAGAIN: return "EAGAIN";
    case ENOMEM: return "ENOMEM";
    case EACCES: return "EACCES";
    case EFAULT: return "EFAULT";
    case EBUSY: return "EBUSY";
    case EEXIST: return "EEXIST";
    case EXDEV: return "EXDEV";
    case ENODEV: return "ENODEV";
    case ENOTDIR: return "ENOTDIR";
    case EISDIR: return "EISDIR";
    case EINVAL: return "EINVAL";
    case ENFILE: return "ENFILE";
    case EMFILE: return "EMFILE";
    case ENOTTY: return "ENOTTY";
    case EFBIG: return "EFBIG";
    case ENOSPC: return "ENOSPC";
    case ESPIPE: return "ESPIPE";
    case EROFS: return "EROFS";
    case EMLINK: return "EMLINK";
    case EPIPE: return "EPIPE";
    case ELOOP: return "ELOOP";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ENOTEMPTY: return "ENOTEMPTY";
#ifdef ENOTSUP
    case ENOTSUP: return "ENOTSUP";
#endif
#ifdef EOPNOTSUPP
#if EOPNOTSUPP != ENOTSUP
    case EOPNOTSUPP: return "EOPNOTSUPP";
#endif
#endif
    default: return nullptr;
  }
}

Napi::Error MakeErrnoError(Napi::Env env, int errnum, const char* syscall) {
  const char* name = ErrnoToName(errnum);
  std::string codeStr = name ? std::string(name)
                             : std::string("E") + std::to_string(errnum);
  std::string message = std::string(syscall) + ": " + codeStr +
                        ": " + std::string(strerror(errnum));
  Napi::Error err = Napi::Error::New(env, message);
  err.Set("errno", Napi::Number::New(env, errnum));
  err.Set("code", Napi::String::New(env, codeStr));
  err.Set("syscall", Napi::String::New(env, syscall));
  return err;
}

// openat(dirfd, name, flags, mode?) → fd
Napi::Value OpenAt(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsNumber()) {
    Napi::TypeError::New(env, "openat(dirfd, name, flags, mode?) — bad args").ThrowAsJavaScriptException();
    return env.Null();
  }
  int dirfd = info[0].As<Napi::Number>().Int32Value();
  std::string name = info[1].As<Napi::String>().Utf8Value();
  int flags = info[2].As<Napi::Number>().Int32Value();
  mode_t mode = 0;
  if (info.Length() >= 4 && info[3].IsNumber()) {
    mode = static_cast<mode_t>(info[3].As<Napi::Number>().Uint32Value());
  }
  int fd = openat(dirfd, name.c_str(), flags, mode);
  if (fd < 0) {
    int e = errno;
    MakeErrnoError(env, e, "openat").ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Number::New(env, fd);
}

// Pin an entry without following links or opening its contents. These handles
// keep an unlinked inode alive throughout approval, preventing inode reuse.
Napi::Value OpenIdentityAt(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
    Napi::TypeError::New(env, "openIdentityAt(dirfd, name) — bad args").ThrowAsJavaScriptException();
    return env.Null();
  }
#ifdef __APPLE__
  int flags = O_EVTONLY | O_SYMLINK | O_CLOEXEC;
#else
  int flags = O_PATH | O_NOFOLLOW | O_CLOEXEC;
#endif
  int fd = openat(info[0].As<Napi::Number>().Int32Value(),
                  info[1].As<Napi::String>().Utf8Value().c_str(), flags);
  if (fd < 0) {
    MakeErrnoError(env, errno, "openIdentityAt").ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Number::New(env, fd);
}

// mkdirat(dirfd, name, mode) → void
Napi::Value MkdirAt(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsNumber()) {
    Napi::TypeError::New(env, "mkdirat(dirfd, name, mode) — bad args").ThrowAsJavaScriptException();
    return env.Null();
  }
  int dirfd = info[0].As<Napi::Number>().Int32Value();
  std::string name = info[1].As<Napi::String>().Utf8Value();
  mode_t mode = static_cast<mode_t>(info[2].As<Napi::Number>().Uint32Value());
  int rc = mkdirat(dirfd, name.c_str(), mode);
  if (rc < 0) {
    int e = errno;
    MakeErrnoError(env, e, "mkdirat").ThrowAsJavaScriptException();
    return env.Null();
  }
  return env.Undefined();
}

// unlinkat(dirfd, name, flags) → void
// flags=0 unlinks a file, AT_REMOVEDIR removes an empty directory.
Napi::Value UnlinkAt(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsNumber()) {
    Napi::TypeError::New(env, "unlinkat(dirfd, name, flags) — bad args").ThrowAsJavaScriptException();
    return env.Null();
  }
  int dirfd = info[0].As<Napi::Number>().Int32Value();
  std::string name = info[1].As<Napi::String>().Utf8Value();
  int flags = info[2].As<Napi::Number>().Int32Value();
  int rc = unlinkat(dirfd, name.c_str(), flags);
  if (rc < 0) {
    int e = errno;
    MakeErrnoError(env, e, "unlinkat").ThrowAsJavaScriptException();
    return env.Null();
  }
  return env.Undefined();
}

// renameat(srcdirfd, srcname, dstdirfd, dstname) → void
Napi::Value RenameAt(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 ||
      !info[0].IsNumber() || !info[1].IsString() ||
      !info[2].IsNumber() || !info[3].IsString()) {
    Napi::TypeError::New(env, "renameat(srcdirfd, srcname, dstdirfd, dstname) — bad args").ThrowAsJavaScriptException();
    return env.Null();
  }
  int srcfd = info[0].As<Napi::Number>().Int32Value();
  std::string srcname = info[1].As<Napi::String>().Utf8Value();
  int dstfd = info[2].As<Napi::Number>().Int32Value();
  std::string dstname = info[3].As<Napi::String>().Utf8Value();
  int rc = renameat(srcfd, srcname.c_str(), dstfd, dstname.c_str());
  if (rc < 0) {
    int e = errno;
    MakeErrnoError(env, e, "renameat").ThrowAsJavaScriptException();
    return env.Null();
  }
  return env.Undefined();
}

// fstatat(dirfd, name, flags) → {dev, ino, mode, nlink, uid, gid, size, isSymlink, isDir, isFile}
// flags=AT_SYMLINK_NOFOLLOW for lstat semantics (don't follow leaf symlinks).
Napi::Value FstatAt(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsNumber()) {
    Napi::TypeError::New(env, "fstatat(dirfd, name, flags) — bad args").ThrowAsJavaScriptException();
    return env.Null();
  }
  int dirfd = info[0].As<Napi::Number>().Int32Value();
  std::string name = info[1].As<Napi::String>().Utf8Value();
  int flags = info[2].As<Napi::Number>().Int32Value();
  struct stat st;
  int rc = fstatat(dirfd, name.c_str(), &st, flags);
  if (rc < 0) {
    int e = errno;
    MakeErrnoError(env, e, "fstatat").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Object out = Napi::Object::New(env);
  out.Set("dev", Napi::Number::New(env, static_cast<double>(st.st_dev)));
  out.Set("ino", Napi::Number::New(env, static_cast<double>(st.st_ino)));
  out.Set("mode", Napi::Number::New(env, static_cast<double>(st.st_mode)));
  out.Set("nlink", Napi::Number::New(env, static_cast<double>(st.st_nlink)));
  out.Set("uid", Napi::Number::New(env, static_cast<double>(st.st_uid)));
  out.Set("gid", Napi::Number::New(env, static_cast<double>(st.st_gid)));
  out.Set("size", Napi::Number::New(env, static_cast<double>(st.st_size)));
  out.Set("isSymlink", Napi::Boolean::New(env, S_ISLNK(st.st_mode)));
  out.Set("isDir", Napi::Boolean::New(env, S_ISDIR(st.st_mode)));
  out.Set("isFile", Napi::Boolean::New(env, S_ISREG(st.st_mode)));
  return out;
}

// readlinkat(dirfd, name) → string (the symlink target)
// Atomic read of a symlink target through a parent dirfd. Errors:
// EINVAL if `name` is not a symlink.
Napi::Value ReadLinkAt(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
    Napi::TypeError::New(env, "readlinkat(dirfd, name) — bad args").ThrowAsJavaScriptException();
    return env.Null();
  }
  int dirfd = info[0].As<Napi::Number>().Int32Value();
  std::string name = info[1].As<Napi::String>().Utf8Value();
  // PATH_MAX on darwin is 1024, on linux 4096 — pick a safe ceiling.
  // readlinkat returns the byte count (NOT NUL-terminated); -1 on error.
  char buf[8192];
  ssize_t n = readlinkat(dirfd, name.c_str(), buf, sizeof(buf) - 1);
  if (n < 0) {
    int e = errno;
    MakeErrnoError(env, e, "readlinkat").ThrowAsJavaScriptException();
    return env.Null();
  }
  if (n >= (ssize_t)(sizeof(buf) - 1)) {
    // Truncation — refuse rather than silently return a partial target.
    MakeErrnoError(env, ENAMETOOLONG, "readlinkat").ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::String::New(env, std::string(buf, (size_t)n));
}

// symlinkat(target, dirfd, name) → void
// Atomic symlink creation: kernel resolves the new link's parent
// directory through `dirfd` (no path re-walk), `target` becomes the
// link's contents (not interpreted at creation time).
Napi::Value SymlinkAt(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsNumber() || !info[2].IsString()) {
    Napi::TypeError::New(env, "symlinkat(target, dirfd, name) — bad args").ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string target = info[0].As<Napi::String>().Utf8Value();
  int dirfd = info[1].As<Napi::Number>().Int32Value();
  std::string name = info[2].As<Napi::String>().Utf8Value();
  int rc = symlinkat(target.c_str(), dirfd, name.c_str());
  if (rc < 0) {
    int e = errno;
    MakeErrnoError(env, e, "symlinkat").ThrowAsJavaScriptException();
    return env.Null();
  }
  return env.Undefined();
}

// readdirAt(dirfd) → array of {name, kind}
//
// Reads all entries of an open directory fd. The dirfd is consumed
// (fdopendir takes ownership; closedir closes the underlying fd),
// so the caller MUST NOT close it themselves. Filters out "." and
// "..". `kind` is one of: "file", "dir", "symlink", "other".
//
// We hand back the entry kind from d_type (no extra fstatat per
// entry), so a caller that needs full stat for each entry should
// invoke fstatat separately. d_type is 'unknown' on some
// filesystems — when that happens, the JS caller can fall back to
// fstatat for that one entry.
Napi::Value ReadDirAt(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "readdirAt(dirfd) — bad args").ThrowAsJavaScriptException();
    return env.Null();
  }
  int dirfd = info[0].As<Napi::Number>().Int32Value();

  // fdopendir takes ownership of the fd. We dup() first so the
  // caller can still close their original fd if they want, and so
  // a closedir failure doesn't leak.
  int duped = dup(dirfd);
  if (duped < 0) {
    int e = errno;
    MakeErrnoError(env, e, "dup").ThrowAsJavaScriptException();
    return env.Null();
  }
  DIR* dir = fdopendir(duped);
  if (!dir) {
    int e = errno;
    close(duped);
    MakeErrnoError(env, e, "fdopendir").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Array out = Napi::Array::New(env);
  uint32_t idx = 0;
  errno = 0;
  struct dirent* entry;
  while ((entry = readdir(dir)) != nullptr) {
    if (entry->d_name[0] == '.' &&
        (entry->d_name[1] == '\0' ||
         (entry->d_name[1] == '.' && entry->d_name[2] == '\0'))) {
      continue;
    }
    Napi::Object o = Napi::Object::New(env);
    o.Set("name", Napi::String::New(env, entry->d_name));
    const char* kind = "other";
    switch (entry->d_type) {
      case DT_REG: kind = "file"; break;
      case DT_DIR: kind = "dir"; break;
      case DT_LNK: kind = "symlink"; break;
      case DT_UNKNOWN: kind = "unknown"; break;
      default: kind = "other"; break;
    }
    o.Set("kind", Napi::String::New(env, kind));
    out.Set(idx++, o);
    errno = 0;
  }
  int saved = errno;
  closedir(dir);  // also closes duped fd
  if (saved != 0) {
    MakeErrnoError(env, saved, "readdir").ThrowAsJavaScriptException();
    return env.Null();
  }
  return out;
}

// closeFd(fd) → void
Napi::Value CloseFd(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "closeFd(fd) — bad args").ThrowAsJavaScriptException();
    return env.Null();
  }
  int fd = info[0].As<Napi::Number>().Int32Value();
  int rc = close(fd);
  if (rc < 0) {
    int e = errno;
    MakeErrnoError(env, e, "close").ThrowAsJavaScriptException();
    return env.Null();
  }
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("openat", Napi::Function::New(env, OpenAt));
  exports.Set("openIdentityAt", Napi::Function::New(env, OpenIdentityAt));
  exports.Set("mkdirat", Napi::Function::New(env, MkdirAt));
  exports.Set("unlinkat", Napi::Function::New(env, UnlinkAt));
  exports.Set("renameat", Napi::Function::New(env, RenameAt));
  exports.Set("fstatat", Napi::Function::New(env, FstatAt));
  exports.Set("readlinkat", Napi::Function::New(env, ReadLinkAt));
  exports.Set("symlinkat", Napi::Function::New(env, SymlinkAt));
  exports.Set("readdirAt", Napi::Function::New(env, ReadDirAt));
  exports.Set("closeFd", Napi::Function::New(env, CloseFd));

  // Constants the JS layer needs
  Napi::Object constants = Napi::Object::New(env);
  constants.Set("O_RDONLY", Napi::Number::New(env, O_RDONLY));
  constants.Set("O_WRONLY", Napi::Number::New(env, O_WRONLY));
  constants.Set("O_RDWR", Napi::Number::New(env, O_RDWR));
  constants.Set("O_CREAT", Napi::Number::New(env, O_CREAT));
  constants.Set("O_EXCL", Napi::Number::New(env, O_EXCL));
  constants.Set("O_TRUNC", Napi::Number::New(env, O_TRUNC));
  constants.Set("O_NOFOLLOW", Napi::Number::New(env, O_NOFOLLOW));
  constants.Set("O_NONBLOCK", Napi::Number::New(env, O_NONBLOCK));
  constants.Set("O_DIRECTORY", Napi::Number::New(env, O_DIRECTORY));
  constants.Set("AT_REMOVEDIR", Napi::Number::New(env, AT_REMOVEDIR));
  constants.Set("AT_SYMLINK_NOFOLLOW", Napi::Number::New(env, AT_SYMLINK_NOFOLLOW));
  exports.Set("constants", constants);

  return exports;
}

}  // namespace

NODE_API_MODULE(dirfd_ops, Init)
