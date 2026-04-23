import AppKit

let projectDir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let outputPath = projectDir.appendingPathComponent("assets/melo-icon.png").path
let size = CGSize(width: 1024, height: 1024)
let canvasRect = CGRect(origin: .zero, size: size)
let tileRect = CGRect(x: 92, y: 92, width: 840, height: 840)

func makePolygon(in rect: CGRect, points: [CGPoint]) -> NSBezierPath {
  let path = NSBezierPath()
  guard let first = points.first else { return path }
  // Normalized points use a top-left origin. Cocoa drawing uses bottom-left,
  // so we flip Y while projecting into the destination rect.
  path.move(to: CGPoint(x: rect.minX + first.x * rect.width, y: rect.maxY - first.y * rect.height))
  for point in points.dropFirst() {
    path.line(to: CGPoint(x: rect.minX + point.x * rect.width, y: rect.maxY - point.y * rect.height))
  }
  path.close()
  return path
}

let image = NSImage(size: size)
image.lockFocus()

NSRectFillUsingOperation(canvasRect, .clear)

let shadow = NSShadow()
shadow.shadowColor = NSColor(calibratedRed: 0.03, green: 0.27, blue: 0.27, alpha: 0.26)
shadow.shadowBlurRadius = 34
shadow.shadowOffset = CGSize(width: 0, height: -18)
shadow.set()

let tilePath = NSBezierPath(roundedRect: tileRect, xRadius: 188, yRadius: 188)
let tileGradient = NSGradient(
  starting: NSColor(calibratedRed: 0.06, green: 0.45, blue: 0.45, alpha: 1.0),
  ending: NSColor(calibratedRed: 0.12, green: 0.73, blue: 0.73, alpha: 1.0)
)!
tileGradient.draw(in: tilePath, angle: -42)

NSGraphicsContext.current?.saveGraphicsState()
let edgePath = NSBezierPath(roundedRect: tileRect.insetBy(dx: 10, dy: 10), xRadius: 174, yRadius: 174)
edgePath.lineWidth = 12
NSColor(calibratedWhite: 1.0, alpha: 0.18).setStroke()
edgePath.stroke()
NSGraphicsContext.current?.restoreGraphicsState()

let markRect = CGRect(x: 222, y: 218, width: 580, height: 580)
let letterPath = makePolygon(in: markRect, points: [
  CGPoint(x: 0.11, y: 0.88), CGPoint(x: 0.11, y: 0.14), CGPoint(x: 0.27, y: 0.14),
  CGPoint(x: 0.50, y: 0.50), CGPoint(x: 0.73, y: 0.14), CGPoint(x: 0.89, y: 0.14),
  CGPoint(x: 0.89, y: 0.88), CGPoint(x: 0.70, y: 0.88), CGPoint(x: 0.70, y: 0.46),
  CGPoint(x: 0.55, y: 0.69), CGPoint(x: 0.45, y: 0.69), CGPoint(x: 0.30, y: 0.46),
  CGPoint(x: 0.30, y: 0.88)
])

let letterGradient = NSGradient(
  starting: NSColor(calibratedRed: 0.85, green: 0.98, blue: 0.99, alpha: 0.98),
  ending: NSColor(calibratedRed: 1.0, green: 1.0, blue: 1.0, alpha: 0.84)
)!
letterGradient.draw(in: letterPath, angle: 0)

let foldPath = makePolygon(in: markRect, points: [
  CGPoint(x: 0.48, y: 0.46), CGPoint(x: 0.56, y: 0.46), CGPoint(x: 0.64, y: 0.58),
  CGPoint(x: 0.56, y: 0.58)
])
NSColor(calibratedWhite: 1.0, alpha: 0.24).setFill()
foldPath.fill()

let orb1Path = NSBezierPath(ovalIn: CGRect(x: 684, y: 654, width: 86, height: 86))
NSColor(calibratedRed: 0.82, green: 1.0, blue: 1.0, alpha: 0.14).setFill()
orb1Path.fill()

let orb2Path = NSBezierPath(ovalIn: CGRect(x: 304, y: 192, width: 66, height: 66))
NSColor(calibratedRed: 1.0, green: 1.0, blue: 1.0, alpha: 0.08).setFill()
orb2Path.fill()

image.unlockFocus()

guard
  let tiff = image.tiffRepresentation,
  let rep = NSBitmapImageRep(data: tiff),
  let png = rep.representation(using: .png, properties: [:])
else {
  fputs("Failed to render icon.\n", stderr)
  exit(1)
}

try png.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
print("Wrote \(outputPath)")
