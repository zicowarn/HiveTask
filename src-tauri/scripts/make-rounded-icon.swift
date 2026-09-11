#!/usr/bin/env swift
/**
 Bake macOS Big Sur–style continuous rounded corners (a "squircle") into the
 app icon source.

 macOS does NOT auto-mask Dock icons (unlike iOS Springboard), so the corner
 radius must be part of the image. We load the existing square artwork, draw
 it on a 1024×1024 transparent canvas clipped to a continuous-corner rect,
 and write a PNG that `pnpm tauri icon` can re-export for every platform.

 Usage:
   swift make-rounded-icon.swift <input.png> <output.png> [canvas] [radiusFraction]
 Defaults: canvas=1024, radiusFraction=0.2235 (≈229px, Big Sur template).
 */
import AppKit

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: make-rounded-icon.swift <input> <output> [size] [radiusFraction]\n".data(using: .utf8)!)
    exit(2)
}
let inputPath = args[1]
let outputPath = args[2]
let size = args.count >= 4 ? (Int(args[3]) ?? 1024) : 1024
let radiusFraction = args.count >= 5 ? (Double(args[4]) ?? 0.2235) : 0.2235

guard let src = NSImage(contentsOfFile: inputPath) else {
    FileHandle.standardError.write("cannot load input: \(inputPath)\n".data(using: .utf8)!)
    exit(1)
}

let rect = NSRect(x: 0, y: 0, width: size, height: size)
let radius = CGFloat(Double(size) * radiusFraction)

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
// visually matches macOS Big Sur's continuous-corner (squircle) template.
// The source artwork already has its own opaque #1e1f22 background, so only
// clipping is needed — everything outside the corner becomes transparent.

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
print("wrote \(outputPath) (\(size)x\(size), radius \(Int(radius)))")
