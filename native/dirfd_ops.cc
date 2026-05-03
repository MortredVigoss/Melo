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
#include <errno.h>
#include <string.h>
#include <string>

namespace {

Napi::Error MakeErrnoError(Napi::Env env, int errnum, const char* syscall) {
  std::string message = std::string(syscall) + ": " + std::string(strerror(errnum));
  Napi::Error err = Napi::Error::New(env, message);
  err.Set("errno", Napi::Number::New(env, errnum));
  err.Set("code", Napi::String::New(env, strerror(errnum)));
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
  exports.Set("mkdirat", Napi::Function::New(env, MkdirAt));
  exports.Set("unlinkat", Napi::Function::New(env, UnlinkAt));
  exports.Set("renameat", Napi::Function::New(env, RenameAt));
  exports.Set("fstatat", Napi::Function::New(env, FstatAt));
  exports.Set("readlinkat", Napi::Function::New(env, ReadLinkAt));
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
  constants.Set("O_DIRECTORY", Napi::Number::New(env, O_DIRECTORY));
  constants.Set("AT_REMOVEDIR", Napi::Number::New(env, AT_REMOVEDIR));
  constants.Set("AT_SYMLINK_NOFOLLOW", Napi::Number::New(env, AT_SYMLINK_NOFOLLOW));
  exports.Set("constants", constants);

  return exports;
}

}  // namespace

NODE_API_MODULE(dirfd_ops, Init)
