import Foundation

enum ExecutionPagePolicy {
    // iOS can expose the same installed bundle through /var and /private/var.
    // Compare canonical entry files, never allow arbitrary file navigation.
    private static func path(_ url: URL) -> String {
        let path = url.resolvingSymlinksInPath().standardizedFileURL.path
        return path.hasPrefix("/private/var/") ? String(path.dropFirst(8)) : path
    }
    static func allows(_ url: URL?, entry: URL?) -> Bool {
        guard let url, let entry, url.isFileURL, entry.isFileURL,
              url.host == nil || url.host == "" || url.host == "localhost" else { return false }
        return path(url) == path(entry)
    }
}
