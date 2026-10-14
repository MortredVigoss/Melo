import AppKit
let root = URL(fileURLWithPath: CommandLine.arguments[1])
for (name, dimension) in [("Icon-60@2x",120),("Icon-60@3x",180),("Icon-1024",1024)] {
 let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: dimension, pixelsHigh: dimension, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
 NSGraphicsContext.saveGraphicsState()
 NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
 NSColor(red:0.025,green:0.03,blue:0.045,alpha:1).setFill()
 NSBezierPath(rect:NSRect(x:0,y:0,width:dimension,height:dimension)).fill()
 let side = Double(dimension)
 for i in 0..<500 {
  let f = Double(i)/500, angle = Double(i)*2.399963
  let radius = sqrt(f)*side*0.38
  let diameter = side*(0.003+(1-f)*0.004)
  NSColor(red:1,green:0.57+f*0.13,blue:0.24,alpha:0.35+(1-f)*0.65).setFill()
  NSBezierPath(ovalIn:NSRect(x:side/2+cos(angle)*radius,y:side/2+sin(angle)*radius*0.8,width:diameter,height:diameter)).fill()
 }
 NSGraphicsContext.restoreGraphicsState()
 try bitmap.representation(using:.png,properties:[:])!.write(to:root.appendingPathComponent(name+".png"))
}
