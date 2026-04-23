import AppKit

let projectDir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let outputDir = projectDir.appendingPathComponent("assets/options").path
let boardPath = outputDir + "/melo-mark-board.png"
let fm = FileManager.default
try fm.createDirectory(atPath: outputDir, withIntermediateDirectories: true)

struct MarkOption {
  let id: String
  let title: String
  let draw: (_ rect: CGRect) -> Void
}

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

func drawTile(in rect: CGRect) {
  NSGraphicsContext.current?.saveGraphicsState()
  let shadow = NSShadow()
  shadow.shadowColor = NSColor(calibratedRed: 0.03, green: 0.27, blue: 0.27, alpha: 0.24)
  shadow.shadowBlurRadius = rect.width * 0.045
  shadow.shadowOffset = CGSize(width: 0, height: -rect.width * 0.02)
  shadow.set()

  let tilePath = NSBezierPath(roundedRect: rect, xRadius: rect.width * 0.22, yRadius: rect.width * 0.22)
  let tileGradient = NSGradient(
    starting: NSColor(calibratedRed: 0.06, green: 0.45, blue: 0.45, alpha: 1.0),
    ending: NSColor(calibratedRed: 0.12, green: 0.73, blue: 0.73, alpha: 1.0)
  )!
  tileGradient.draw(in: tilePath, angle: -42)
  NSGraphicsContext.current?.restoreGraphicsState()

  let edgePath = NSBezierPath(roundedRect: rect.insetBy(dx: rect.width * 0.012, dy: rect.width * 0.012), xRadius: rect.width * 0.205, yRadius: rect.width * 0.205)
  edgePath.lineWidth = rect.width * 0.012
  NSColor(calibratedWhite: 1.0, alpha: 0.16).setStroke()
  edgePath.stroke()

  let orb1 = NSBezierPath(ovalIn: CGRect(x: rect.minX + rect.width * 0.69, y: rect.minY + rect.height * 0.71, width: rect.width * 0.11, height: rect.width * 0.11))
  NSColor(calibratedRed: 0.82, green: 1.0, blue: 1.0, alpha: 0.12).setFill()
  orb1.fill()

  let orb2 = NSBezierPath(ovalIn: CGRect(x: rect.minX + rect.width * 0.22, y: rect.minY + rect.height * 0.14, width: rect.width * 0.08, height: rect.width * 0.08))
  NSColor(calibratedRed: 1.0, green: 1.0, blue: 1.0, alpha: 0.07).setFill()
  orb2.fill()
}

func drawFillGradient(path: NSBezierPath) {
  let gradient = NSGradient(
    starting: NSColor(calibratedRed: 0.85, green: 0.98, blue: 0.99, alpha: 0.98),
    ending: NSColor(calibratedRed: 1.0, green: 1.0, blue: 1.0, alpha: 0.84)
  )!
  gradient.draw(in: path, angle: 0)
}

let options: [MarkOption] = [
  MarkOption(id: "A", title: "Geometric Bridge") { rect in
    let path = makePolygon(in: rect, points: [
      CGPoint(x: 0.06, y: 0.12), CGPoint(x: 0.06, y: 0.88), CGPoint(x: 0.24, y: 0.88),
      CGPoint(x: 0.24, y: 0.42), CGPoint(x: 0.42, y: 0.65), CGPoint(x: 0.58, y: 0.65),
      CGPoint(x: 0.76, y: 0.42), CGPoint(x: 0.76, y: 0.88), CGPoint(x: 0.94, y: 0.88),
      CGPoint(x: 0.94, y: 0.12), CGPoint(x: 0.76, y: 0.12), CGPoint(x: 0.56, y: 0.44),
      CGPoint(x: 0.44, y: 0.44), CGPoint(x: 0.24, y: 0.12)
    ])
    drawFillGradient(path: path)
  },
  MarkOption(id: "B", title: "Ribbon Fold") { rect in
    let path = makePolygon(in: rect, points: [
      CGPoint(x: 0.11, y: 0.88), CGPoint(x: 0.11, y: 0.14), CGPoint(x: 0.27, y: 0.14),
      CGPoint(x: 0.50, y: 0.50), CGPoint(x: 0.73, y: 0.14), CGPoint(x: 0.89, y: 0.14),
      CGPoint(x: 0.89, y: 0.88), CGPoint(x: 0.70, y: 0.88), CGPoint(x: 0.70, y: 0.46),
      CGPoint(x: 0.55, y: 0.69), CGPoint(x: 0.45, y: 0.69), CGPoint(x: 0.30, y: 0.46),
      CGPoint(x: 0.30, y: 0.88)
    ])
    drawFillGradient(path: path)

    let fold = makePolygon(in: rect, points: [
      CGPoint(x: 0.48, y: 0.46), CGPoint(x: 0.56, y: 0.46), CGPoint(x: 0.64, y: 0.58),
      CGPoint(x: 0.56, y: 0.58)
    ])
    NSColor(calibratedWhite: 1.0, alpha: 0.24).setFill()
    fold.fill()
  },
  MarkOption(id: "C", title: "Rounded Monoline") { rect in
    let path = NSBezierPath()
    path.move(to: CGPoint(x: rect.minX + rect.width * 0.18, y: rect.maxY - rect.height * 0.16))
    path.line(to: CGPoint(x: rect.minX + rect.width * 0.18, y: rect.maxY - rect.height * 0.84))
    path.line(to: CGPoint(x: rect.minX + rect.width * 0.50, y: rect.maxY - rect.height * 0.45))
    path.line(to: CGPoint(x: rect.minX + rect.width * 0.82, y: rect.maxY - rect.height * 0.84))
    path.line(to: CGPoint(x: rect.minX + rect.width * 0.82, y: rect.maxY - rect.height * 0.16))
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    path.lineWidth = rect.width * 0.16

    let gradient = NSGradient(
      starting: NSColor(calibratedRed: 0.85, green: 0.98, blue: 0.99, alpha: 0.98),
      ending: NSColor(calibratedRed: 1.0, green: 1.0, blue: 1.0, alpha: 0.84)
    )!
    gradient.draw(in: path, angle: 0)
  },
  MarkOption(id: "D", title: "Sharp Crest") { rect in
    let path = makePolygon(in: rect, points: [
      CGPoint(x: 0.08, y: 0.88), CGPoint(x: 0.08, y: 0.12), CGPoint(x: 0.28, y: 0.12),
      CGPoint(x: 0.42, y: 0.36), CGPoint(x: 0.50, y: 0.30), CGPoint(x: 0.58, y: 0.36),
      CGPoint(x: 0.72, y: 0.12), CGPoint(x: 0.92, y: 0.12), CGPoint(x: 0.92, y: 0.88),
      CGPoint(x: 0.72, y: 0.88), CGPoint(x: 0.72, y: 0.42), CGPoint(x: 0.56, y: 0.68),
      CGPoint(x: 0.44, y: 0.68), CGPoint(x: 0.28, y: 0.42), CGPoint(x: 0.28, y: 0.88)
    ])
    drawFillGradient(path: path)
  },
]

func renderIcon(option: MarkOption, outputPath: String) throws {
  let size = CGSize(width: 1024, height: 1024)
  let rect = CGRect(origin: .zero, size: size)
  let tileRect = CGRect(x: 92, y: 92, width: 840, height: 840)
  let markRect = CGRect(x: 222, y: 218, width: 580, height: 580)

  let image = NSImage(size: size)
  image.lockFocus()
  NSRectFillUsingOperation(rect, .clear)
  drawTile(in: tileRect)
  option.draw(markRect)
  image.unlockFocus()

  guard
    let tiff = image.tiffRepresentation,
    let rep = NSBitmapImageRep(data: tiff),
    let png = rep.representation(using: .png, properties: [:])
  else {
    throw NSError(domain: "Render", code: 1)
  }

  try png.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
}

for option in options {
  try renderIcon(option: option, outputPath: outputDir + "/option-\(option.id.lowercased()).png")
}

let boardSize = CGSize(width: 2200, height: 1340)
let board = NSImage(size: boardSize)
board.lockFocus()

NSColor(calibratedWhite: 0.96, alpha: 1.0).setFill()
CGRect(origin: .zero, size: boardSize).fill()

let titleFont = NSFont.systemFont(ofSize: 52, weight: .semibold)
let metaFont = NSFont.systemFont(ofSize: 28, weight: .medium)
let titleAttrs: [NSAttributedString.Key: Any] = [
  .font: titleFont,
  .foregroundColor: NSColor(calibratedWhite: 0.13, alpha: 1.0)
]
let metaAttrs: [NSAttributedString.Key: Any] = [
  .font: metaFont,
  .foregroundColor: NSColor(calibratedWhite: 0.38, alpha: 1.0)
]

// Board text uses Cocoa's default bottom-left coordinate system.
NSString(string: "Melo Icon Mark Options").draw(at: CGPoint(x: 100, y: 1230), withAttributes: titleAttrs)
NSString(string: "Same outer shape, four different M directions").draw(at: CGPoint(x: 102, y: 1188), withAttributes: metaAttrs)

let slots: [CGRect] = [
  CGRect(x: 110, y: 635, width: 430, height: 430),
  CGRect(x: 610, y: 635, width: 430, height: 430),
  CGRect(x: 1110, y: 635, width: 430, height: 430),
  CGRect(x: 1610, y: 635, width: 430, height: 430),
]

for (option, slot) in zip(options, slots) {
  let icon = NSImage(contentsOfFile: outputDir + "/option-\(option.id.lowercased()).png")
  icon?.draw(in: slot)

  let label = "\(option.id). \(option.title)"
  NSString(string: label).draw(at: CGPoint(x: slot.minX + 22, y: slot.minY - 64), withAttributes: titleAttrs.merging([.font: NSFont.systemFont(ofSize: 30, weight: .semibold)]) { _, new in new })
}

board.unlockFocus()

guard
  let boardTiff = board.tiffRepresentation,
  let boardRep = NSBitmapImageRep(data: boardTiff),
  let boardPng = boardRep.representation(using: .png, properties: [:])
else {
  throw NSError(domain: "Render", code: 2)
}

try boardPng.write(to: URL(fileURLWithPath: boardPath), options: .atomic)
print("Wrote \(boardPath)")
