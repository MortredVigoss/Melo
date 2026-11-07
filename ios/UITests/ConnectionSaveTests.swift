import XCTest

final class ConnectionSaveTests: XCTestCase {
    private let app = XCUIApplication()

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    private func saveConnection() {
        let save = app.buttons["connection.save"]
        let form = app.scrollViews.containing(.button, identifier: "connection.save").firstMatch
        let navigation = app.navigationBars["模型连接与 API Key"]
        for _ in 0..<6 {
            let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : app.frame.maxY
            if save.isHittable && save.frame.minY >= navigation.frame.maxY && save.frame.maxY <= bottom { break }
            form.swipeDown()
        }
        XCTAssertTrue(save.isHittable)
        XCTAssertGreaterThanOrEqual(save.frame.minY, navigation.frame.maxY)
        save.tap()
        XCTAssertTrue(app.buttons["connection.edit"].waitForExistence(timeout: 5), "Saving must finish before testing or reopening the connection.")
    }

    private func openSettings() {
        app.launchArguments = ["-melo-preview-section", "3", "-melo.interfaceLanguage", "zh-CN", "-AppleLanguages", "(zh-Hans)"]
        app.launch()
        let settings = app.buttons["模型连接与 API Key"]
        XCTAssertTrue(settings.waitForExistence(timeout: 12))
        settings.tap()
    }

    func testSaveKeyThenReopenAndUseConnection() throws {
        continueAfterFailure = false
        openSettings()
        let methods = app.segmentedControls["connection.method"]
        XCTAssertTrue(methods.waitForExistence(timeout: 5))
        XCTAssertFalse(app.secureTextFields.firstMatch.exists)
        capture("ChatGPT login form")
        methods.buttons["API Key"].tap()
        XCTAssertTrue(app.buttons["添加 API Key 连接"].waitForExistence(timeout: 5))
        methods.buttons["ChatGPT 账号登录"].tap()
        XCTAssertFalse(app.secureTextFields.firstMatch.exists)
        methods.buttons["API Key"].tap()
        app.buttons["添加 API Key 连接"].tap()
        app.buttons["自定义兼容服务"].tap()
        let endpoint = app.textFields["服务 Base URL（HTTPS）"]
        endpoint.tap()
        let fixture = ProcessInfo.processInfo.environment["MELO_CONNECTION_QA_URL"]
        if let fixture {
            XCTAssertEqual(URL(string: fixture)?.host, "127.0.0.1")
        }
        let service = fixture ?? "https://example.invalid/v1"
        endpoint.typeText(service)
        capture("Custom API connection form")
        let key = app.secureTextFields.firstMatch
        key.tap()
        key.typeText("melo-ui-fixture-key")
        saveConnection()
        let saved = app.staticTexts["API Key 已保存"]
        XCTAssertTrue(saved.waitForExistence(timeout: 5), "The saved credential needs a visible receipt alongside the account.")
        app.terminate()
        openSettings()
        XCTAssertTrue(saved.waitForExistence(timeout: 5), "Reopening must show the account just saved, even when Codex is still the default.")
        capture("Reopened saved connection")
        app.buttons["connection.edit"].tap()
        let model = app.textFields["模型 ID"]
        model.tap()
        model.typeText("melo-ui-fixture")
        saveConnection()
        XCTAssertTrue(saved.exists)
        if fixture != nil {
            app.buttons["测试已保存连接"].tap()
            XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "MELO_KEY_ACCEPTED")).firstMatch.waitForExistence(timeout: 20))
            app.buttons["设为默认连接"].tap()
            app.terminate()
            app.launchArguments = ["-melo.interfaceLanguage", "zh-CN"]
            app.launch()
            app.buttons["从一个想法开始…"].tap()
            let composer = app.descendants(matching: .any)["chat.composer"]
            composer.tap()
            composer.typeText("Hello")
            app.buttons["发送消息"].tap()
            XCTAssertTrue(app.staticTexts["MELO_CHAT_ACCEPTED"].firstMatch.waitForExistence(timeout: 35))
        }
    }
}
