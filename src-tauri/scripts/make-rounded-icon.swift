#!/usr/bin/env swift
/**
 Bake macOS Big Sur–style rounded corners into the app icon source.

 macOS does NOT auto-mask Dock icons (unlike iOS Springboard), so both the
 corner radius and the tile's padding must be part of the image.

 Apple's macOS icon grid is a 1024×1024 canvas whose rounded tile occupies
 only ~805×805 (≈80.5%), the rest being transparent padding — a full-bleed
 tile looks oversized next to stock apps. So we draw the artwork into a
 centered inset tile with transparent padding around it.

 Usage:
   swift make-rounded-icon.swift <input.png> <output.png> [canvas] [tile] [radiusFraction]
 Defaults: canvas=1024, tile=0.82 (tile side ÷ canvas), radiusFraction=0.2235
           (corner radius ÷ tile side; ≈ Apple's 185.4/824).
 */
import AppKit

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write(
        "usage: make-rounded-icon.swift <input> <output> [size] [tileFraction] [radiusFraction]\n"
            .data(using: .utf8)!)
    exit(2)
}
let inputPath = args[1]
let outputPath = args[2]
let size = args.count >= 4 ? (Int(args[3]) ?? 1024) : 1024
let tileFraction = args.count >= 5 ? (Double(args[4]) ?? 0.82) : 0.82
let radiusFraction = args.count >= 6 ? (Double(args[5]) ?? 0.2235) : 0.2235

guard let src = NSImage(contentsOfFile: inputPath) else {
    FileHandle.standardError.write("cannot load input: \(inputPath)\n".data(using: .utf8)!)
    exit(1)
}

// Centered tile: inset from the canvas so the icon matches the macOS grid
// instead of bleeding to the edges.
let side = Double(size) * tileFraction
let origin = (Double(size) - side) / 2
let rect = NSRect(x: origin, y: origin, width: side, height: side)
// Radius is relative to the tile side, so the corner look is independent of
// how much padding we add.
let radius = CGFloat(side * radiusFraction)

// Render into an explicit size×size RGBA bitmap (scale-independent — using
// lockFocus would inherit the display's backing scale and drift on Retina).
guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
    FileHandle.standardError.write("failed to create bitmap\n".data(using: .utf8)!)
    exit(1)
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
path.addClip()

// NSBezierPath's roundedRect is a circular-arc corner; the ~0.2235 fraction
// visually matches macOS Big Sur's continuous-corner template. The source
// artwork has its own opaque #1e1f22 background, so clipping alone leaves the
// padding and the corner cut-outs fully transparent.

src.draw(in: rect,
         from: NSRect(x: 0, y: 0, width: src.size.width, height: src.size.height),
         operation: .sourceOver,
         fraction: 1.0)

NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("failed to encode PNG\n".data(using: .utf8)!)
    exit(1)
}
try png.write(to: URL(fileURLWithPath: outputPath))
print("wrote \(outputPath) (\(size)x\(size), tile \(Int(side)) @\(Int(origin)), radius \(Int(radius)))")
