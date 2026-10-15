import SwiftUI
import UIKit

// UIScrollView keeps pinch focal points, cumulative scale, inertia and elastic
// zoom limits in the same native gesture engine as photo viewers. SwiftUI
// updates must not recreate the image or reset a gesture in progress.
struct ImageZoomView: UIViewRepresentable {
    let image: UIImage
    let imageID: String
    func makeUIView(context: Context) -> ImageZoomScrollView { ImageZoomScrollView() }
    func updateUIView(_ view: ImageZoomScrollView, context: Context) {
        view.display(image, id: imageID)
    }
}

final class ImageZoomScrollView: UIScrollView, UIScrollViewDelegate {
    let bitmap = UIImageView()
    private var imageID: String?
    private var viewport = CGSize.zero
    private var fitting = false

    init() {
        super.init(frame: .zero)
        delegate = self
        minimumZoomScale = 1
        maximumZoomScale = 4
        bouncesZoom = true
        bounces = true
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        clipsToBounds = true
        bitmap.contentMode = .scaleAspectFit
        addSubview(bitmap)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
        accessibilityIdentifier = "image.preview.zoom"
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func display(_ image: UIImage, id: String) {
        guard imageID != id else { return }
        imageID = id
        bitmap.image = image
        viewport = .zero
        setZoomScale(1, animated: false)
        setNeedsLayout()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        guard !fitting, let image = bitmap.image, bounds.width > 0, bounds.height > 0 else { return }
        if viewport != bounds.size {
            fitting = true
            let oldScale = zoomScale
            let center = CGPoint(x: bounds.midX, y: bounds.midY)
            let focus = convert(center, to: bitmap)
            let fraction = CGPoint(x: bitmap.bounds.width > 0 ? focus.x / bitmap.bounds.width : 0.5,
                                   y: bitmap.bounds.height > 0 ? focus.y / bitmap.bounds.height : 0.5)
            let initial = viewport == .zero
            viewport = bounds.size
            setZoomScale(1, animated: false)
            let fit = min(bounds.width / image.size.width, bounds.height / image.size.height)
            bitmap.frame = CGRect(origin: .zero, size: CGSize(width: image.size.width * fit, height: image.size.height * fit))
            contentSize = bitmap.bounds.size
            setZoomScale(initial ? 1 : oldScale, animated: false)
            centerImage()
            let x = fraction.x * contentSize.width - bounds.width / 2
            let y = fraction.y * contentSize.height - bounds.height / 2
            contentOffset = CGPoint(x: min(max(x, -contentInset.left), max(-contentInset.left, contentSize.width - bounds.width + contentInset.right)),
                                    y: min(max(y, -contentInset.top), max(-contentInset.top, contentSize.height - bounds.height + contentInset.bottom)))
            fitting = false
        }
        centerImage()
    }
    func viewForZooming(in scrollView: UIScrollView) -> UIView? { bitmap }
    func scrollViewDidZoom(_ scrollView: UIScrollView) { centerImage() }
    private func centerImage() {
        let x = max(0, (bounds.width - bitmap.frame.width) / 2)
        let y = max(0, (bounds.height - bitmap.frame.height) / 2)
        let inset = UIEdgeInsets(top: y, left: x, bottom: y, right: x)
        if contentInset != inset { contentInset = inset }
        accessibilityValue = "\(Int(zoomScale * 100))%"
    }
    @objc private func toggleZoom(_ gesture: UITapGestureRecognizer) {
        let scale: CGFloat = zoomScale > 1.01 ? 1 : 2
        let point = gesture.location(in: bitmap)
        let size = CGSize(width: bounds.width / scale, height: bounds.height / scale)
        zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
    }
}
