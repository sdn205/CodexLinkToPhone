#include "PhoneManagerClient.h"
#include "management/Manager.h"
#include <shellapi.h>
#include "resource.h"

#include <windows.h>
#include <commctrl.h>
#include <d2d1.h>
#include <dwrite.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <thread>

namespace {

using phone_assistant::ComponentStatus;
using phone_assistant::ManagerAction;
using phone_assistant::ManagerResult;
using phone_assistant::ManagerSnapshot;
using phone_assistant::StatusLevel;
using Microsoft::WRL::ComPtr;

constexpr wchar_t kWindowClassName[] = L"CodexPhoneAssistantWindow";
constexpr wchar_t kWindowTitle[] = L"Codex手机助手";
constexpr UINT kManagerCompletedMessage = WM_APP + 1;
constexpr UINT_PTR kRefreshTimer = 1;
constexpr UINT_PTR kSpinnerTimer = 2;

constexpr int kEnableButton = 1001;
constexpr int kDisableButton = 1002;
constexpr int kRestartButton = 1003;
constexpr int kStopButton = 1004;

constexpr COLORREF kCanvas = RGB(246, 248, 250);
constexpr COLORREF kSurface = RGB(255, 255, 255);
constexpr COLORREF kText = RGB(31, 41, 55);
constexpr COLORREF kMutedText = RGB(102, 112, 125);
constexpr COLORREF kFaintText = RGB(132, 142, 154);
constexpr COLORREF kDivider = RGB(229, 233, 238);
constexpr COLORREF kAccent = RGB(37, 99, 235);
constexpr COLORREF kAccentHover = RGB(29, 78, 216);
constexpr COLORREF kAccentPressed = RGB(30, 64, 175);
constexpr COLORREF kAccentSoft = RGB(235, 242, 255);
constexpr COLORREF kGreen = RGB(38, 137, 91);
constexpr COLORREF kYellow = RGB(190, 127, 14);
constexpr COLORREF kRed = RGB(197, 65, 65);
constexpr COLORREF kUnknown = RGB(145, 154, 165);

int ScaleValue(int logical, UINT dpi) {
    return MulDiv(logical, static_cast<int>(dpi), 96);
}

D2D1_COLOR_F DirectColor(COLORREF color) {
    return D2D1::ColorF(
        static_cast<float>(GetRValue(color)) / 255.0F,
        static_cast<float>(GetGValue(color)) / 255.0F,
        static_cast<float>(GetBValue(color)) / 255.0F,
        1.0F);
}

COLORREF LevelColor(StatusLevel level) {
    switch (level) {
        case StatusLevel::Ok:
            return kGreen;
        case StatusLevel::Warning:
            return kYellow;
        case StatusLevel::Error:
            return kRed;
        case StatusLevel::Unknown:
            return kUnknown;
    }
    return kUnknown;
}

std::wstring TimeText(bool success) {
    SYSTEMTIME now{};
    GetLocalTime(&now);
    wchar_t buffer[64]{};
    swprintf_s(
        buffer, success ? L"刷新于 %02u:%02u:%02u" : L"刷新失败 %02u:%02u:%02u",
        now.wHour, now.wMinute, now.wSecond);
    return buffer;
}

std::wstring DefaultActionMessage(ManagerAction action, bool success) {
    if (!success) {
        return L"操作未完成";
    }
    switch (action) {
        case ManagerAction::Enable:
            return L"代理模式已开启";
        case ManagerAction::Disable:
            return L"代理模式已关闭";
        case ManagerAction::Restart:
            return L"手机桥已启动或安全重启";
        case ManagerAction::Stop:
            return L"手机桥已结束";
        case ManagerAction::Status:
            return L"状态已刷新";
    }
    return L"操作完成";
}

class PhoneAssistantWindow {
public:
    explicit PhoneAssistantWindow(HINSTANCE instance) : instance_(instance) {}

    ~PhoneAssistantWindow() {
        DeleteFonts();
    }

    bool CreateAndShow(int showCommand) {
        WNDCLASSEXW windowClass{};
        windowClass.cbSize = sizeof(windowClass);
        windowClass.style = CS_HREDRAW | CS_VREDRAW;
        windowClass.lpfnWndProc = WindowProcedure;
        windowClass.hInstance = instance_;
        windowClass.hIcon = LoadIconW(instance_, MAKEINTRESOURCEW(IDI_APP_ICON));
        windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
        windowClass.hbrBackground = nullptr;
        windowClass.lpszClassName = kWindowClassName;
        windowClass.hIconSm = static_cast<HICON>(LoadImageW(
            instance_, MAKEINTRESOURCEW(IDI_APP_ICON), IMAGE_ICON,
            GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), LR_DEFAULTCOLOR));
        if (RegisterClassExW(&windowClass) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
            return false;
        }

        const UINT initialDpi = GetDpiForSystem();
        RECT windowRect{
            0, 0, ScaleValue(600, initialDpi), ScaleValue(540, initialDpi)};
        AdjustWindowRectExForDpi(
            &windowRect, WS_OVERLAPPEDWINDOW, FALSE, 0, initialDpi);
        const int width = windowRect.right - windowRect.left;
        const int height = windowRect.bottom - windowRect.top;

        POINT cursor{};
        GetCursorPos(&cursor);
        const HMONITOR monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTOPRIMARY);
        MONITORINFO monitorInfo{sizeof(monitorInfo)};
        GetMonitorInfoW(monitor, &monitorInfo);
        const int x = monitorInfo.rcWork.left +
            ((monitorInfo.rcWork.right - monitorInfo.rcWork.left) - width) / 2;
        const int y = monitorInfo.rcWork.top +
            ((monitorInfo.rcWork.bottom - monitorInfo.rcWork.top) - height) / 2;

        hwnd_ = CreateWindowExW(
            0, kWindowClassName, kWindowTitle, WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
            x, y, width, height, nullptr, nullptr, instance_, this);
        if (hwnd_ == nullptr) {
            return false;
        }

        const UINT windowDpi = GetDpiForWindow(hwnd_);
        RECT dpiCorrectedRect{
            0, 0, ScaleValue(600, windowDpi), ScaleValue(540, windowDpi)};
        AdjustWindowRectExForDpi(
            &dpiCorrectedRect, WS_OVERLAPPEDWINDOW, FALSE, 0, windowDpi);
        const int correctedWidth = dpiCorrectedRect.right - dpiCorrectedRect.left;
        const int correctedHeight = dpiCorrectedRect.bottom - dpiCorrectedRect.top;
        const HMONITOR windowMonitor = MonitorFromWindow(hwnd_, MONITOR_DEFAULTTONEAREST);
        MONITORINFO windowMonitorInfo{sizeof(windowMonitorInfo)};
        GetMonitorInfoW(windowMonitor, &windowMonitorInfo);
        const int correctedX = windowMonitorInfo.rcWork.left +
            ((windowMonitorInfo.rcWork.right - windowMonitorInfo.rcWork.left) - correctedWidth) / 2;
        const int correctedY = windowMonitorInfo.rcWork.top +
            ((windowMonitorInfo.rcWork.bottom - windowMonitorInfo.rcWork.top) - correctedHeight) / 2;
        SetWindowPos(
            hwnd_, nullptr, correctedX, correctedY, correctedWidth, correctedHeight,
            SWP_NOACTIVATE | SWP_NOZORDER);

        ShowWindow(hwnd_, showCommand);
        UpdateWindow(hwnd_);
        return true;
    }

private:
    static LRESULT CALLBACK WindowProcedure(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
        PhoneAssistantWindow* self = reinterpret_cast<PhoneAssistantWindow*>(
            GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        if (message == WM_NCCREATE) {
            const auto* create = reinterpret_cast<CREATESTRUCTW*>(lParam);
            self = static_cast<PhoneAssistantWindow*>(create->lpCreateParams);
            self->hwnd_ = hwnd;
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
        }
        if (self != nullptr) {
            return self->HandleMessage(message, wParam, lParam);
        }
        return DefWindowProcW(hwnd, message, wParam, lParam);
    }

    static LRESULT CALLBACK ButtonSubclassProcedure(
        HWND button, UINT message, WPARAM wParam, LPARAM lParam,
        UINT_PTR subclassId, DWORD_PTR referenceData) {
        auto* self = reinterpret_cast<PhoneAssistantWindow*>(referenceData);
        switch (message) {
            case WM_MOUSEMOVE: {
                if (GetPropW(button, L"CodexPhoneAssistantHover") == nullptr) {
                    SetPropW(button, L"CodexPhoneAssistantHover", reinterpret_cast<HANDLE>(1));
                    TRACKMOUSEEVENT tracking{sizeof(tracking), TME_LEAVE, button, 0};
                    TrackMouseEvent(&tracking);
                    InvalidateRect(button, nullptr, FALSE);
                }
                break;
            }
            case WM_MOUSELEAVE:
                RemovePropW(button, L"CodexPhoneAssistantHover");
                InvalidateRect(button, nullptr, FALSE);
                break;
            case WM_SETFOCUS:
            case WM_KILLFOCUS:
            case WM_ENABLE:
                InvalidateRect(button, nullptr, FALSE);
                break;
            case WM_NCDESTROY:
                RemovePropW(button, L"CodexPhoneAssistantHover");
                RemoveWindowSubclass(button, ButtonSubclassProcedure, subclassId);
                break;
            default:
                break;
        }
        (void)self;
        return DefSubclassProc(button, message, wParam, lParam);
    }

    LRESULT HandleMessage(UINT message, WPARAM wParam, LPARAM lParam) {
        switch (message) {
            case WM_CREATE:
                return OnCreate() ? 0 : -1;
            case WM_SIZE:
                if (hwndRenderTarget_ && wParam != SIZE_MINIMIZED) {
                    hwndRenderTarget_->Resize(D2D1::SizeU(LOWORD(lParam), HIWORD(lParam)));
                }
                LayoutButtons();
                InvalidateRect(hwnd_, nullptr, FALSE);
                return 0;
            case WM_DPICHANGED:
                OnDpiChanged(wParam, lParam);
                return 0;
            case WM_GETMINMAXINFO:
                OnGetMinMaxInfo(reinterpret_cast<MINMAXINFO*>(lParam));
                return 0;
            case WM_ERASEBKGND:
                return 1;
            case WM_PAINT:
                Paint();
                return 0;
            case WM_DRAWITEM:
                if (DrawButton(reinterpret_cast<DRAWITEMSTRUCT*>(lParam))) {
                    return TRUE;
                }
                break;
            case WM_COMMAND:
                if (HIWORD(wParam) == BN_CLICKED) {
                    OnButtonClicked(LOWORD(wParam));
                    return 0;
                }
                break;
            case WM_TIMER:
                OnTimer(wParam);
                return 0;
            case WM_KEYDOWN:
                if (wParam == VK_F5) {
                    BeginStatusRefresh();
                    return 0;
                }
                break;
            case kManagerCompletedMessage:
                OnManagerCompleted(std::unique_ptr<ManagerResult>(
                    reinterpret_cast<ManagerResult*>(lParam)));
                return 0;
            case WM_CLOSE:
                if (actionInProgress_) {
                    closeAfterAction_ = true;
                    return 0;
                }
                break;
            case WM_DESTROY:
                closing_ = true;
                KillTimer(hwnd_, kRefreshTimer);
                KillTimer(hwnd_, kSpinnerTimer);
                PostQuitMessage(0);
                return 0;
            default:
                break;
        }
        return DefWindowProcW(hwnd_, message, wParam, lParam);
    }

    bool OnCreate() {
        dpi_ = GetDpiForWindow(hwnd_);
        CreateFonts();
        if (!InitializeDirectRendering()) {
            return false;
        }

        constexpr std::array<std::pair<int, const wchar_t*>, 4> buttons{{
            {kEnableButton, L"开启代理模式"},
            {kDisableButton, L"关闭代理模式"},
            {kRestartButton, L"启动/重启手机桥"},
            {kStopButton, L"结束手机桥"},
        }};
        for (std::size_t index = 0; index < buttons.size(); ++index) {
            const auto [id, label] = buttons[index];
            buttonHandles_[index] = CreateWindowExW(
                0, L"BUTTON", label,
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW,
                0, 0, 0, 0, hwnd_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),
                instance_, nullptr);
            if (buttonHandles_[index] == nullptr) {
                return false;
            }
            SendMessageW(buttonHandles_[index], WM_SETFONT, reinterpret_cast<WPARAM>(buttonFont_), TRUE);
            SetWindowSubclass(
                buttonHandles_[index], ButtonSubclassProcedure,
                static_cast<UINT_PTR>(id), reinterpret_cast<DWORD_PTR>(this));
        }

        LayoutButtons();
        SetTimer(hwnd_, kRefreshTimer, 2000, nullptr);
        BeginStatusRefresh();
        return true;
    }

    void CreateFonts() {
        DeleteFonts();
        titleFont_ = MakeFont(25, FW_SEMIBOLD);
        sectionFont_ = MakeFont(14, FW_SEMIBOLD);
        bodyFont_ = MakeFont(15, FW_NORMAL);
        bodyStrongFont_ = MakeFont(15, FW_MEDIUM);
        smallFont_ = MakeFont(13, FW_NORMAL);
        buttonFont_ = MakeFont(15, FW_MEDIUM);
        iconFont_ = CreateFontW(
            -ScaleValue(17, dpi_), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
            DEFAULT_CHARSET, OUT_TT_PRECIS, CLIP_DEFAULT_PRECIS,
            ANTIALIASED_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Segoe MDL2 Assets");
    }

    HFONT MakeFont(int logicalPixels, int weight) const {
        return CreateFontW(
            -ScaleValue(logicalPixels, dpi_), 0, 0, 0, weight, FALSE, FALSE, FALSE,
            DEFAULT_CHARSET, OUT_TT_PRECIS, CLIP_DEFAULT_PRECIS,
            ANTIALIASED_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Noto Sans SC");
    }

    void DeleteFonts() {
        for (HFONT* font : {
                 &titleFont_, &sectionFont_, &bodyFont_, &bodyStrongFont_,
                 &smallFont_, &buttonFont_, &iconFont_}) {
            if (*font != nullptr) {
                DeleteObject(*font);
                *font = nullptr;
            }
        }
    }

    bool InitializeDirectRendering() {
        if (FAILED(D2D1CreateFactory(
                D2D1_FACTORY_TYPE_SINGLE_THREADED,
                d2dFactory_.ReleaseAndGetAddressOf()))) {
            return false;
        }
        if (FAILED(DWriteCreateFactory(
                DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                reinterpret_cast<IUnknown**>(dwriteFactory_.ReleaseAndGetAddressOf())))) {
            return false;
        }
        ComPtr<IDWriteRenderingParams> renderingParams;
        if (FAILED(dwriteFactory_->CreateCustomRenderingParams(
                2.2F, 1.25F, 0.0F, DWRITE_PIXEL_GEOMETRY_FLAT,
                DWRITE_RENDERING_MODE_NATURAL_SYMMETRIC,
                renderingParams.GetAddressOf()))) {
            return false;
        }
        textRenderingParams_ = std::move(renderingParams);
        return CreateHwndRenderTarget() && CreateDcRenderTarget() && CreateTextFormats();
    }

    bool CreateHwndRenderTarget() {
        if (!d2dFactory_ || !hwnd_) {
            return false;
        }
        RECT client{};
        GetClientRect(hwnd_, &client);
        const auto properties = D2D1::RenderTargetProperties(
            D2D1_RENDER_TARGET_TYPE_DEFAULT,
            D2D1::PixelFormat(DXGI_FORMAT_UNKNOWN, D2D1_ALPHA_MODE_UNKNOWN),
            96.0F, 96.0F);
        const auto hwndProperties = D2D1::HwndRenderTargetProperties(
            hwnd_, D2D1::SizeU(client.right, client.bottom),
            D2D1_PRESENT_OPTIONS_NONE);
        return SUCCEEDED(d2dFactory_->CreateHwndRenderTarget(
            properties, hwndProperties, hwndRenderTarget_.ReleaseAndGetAddressOf()));
    }

    bool CreateDcRenderTarget() {
        if (!d2dFactory_) {
            return false;
        }
        const auto properties = D2D1::RenderTargetProperties(
            D2D1_RENDER_TARGET_TYPE_DEFAULT,
            D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_IGNORE),
            96.0F, 96.0F, D2D1_RENDER_TARGET_USAGE_GDI_COMPATIBLE,
            D2D1_FEATURE_LEVEL_DEFAULT);
        return SUCCEEDED(d2dFactory_->CreateDCRenderTarget(
            &properties, dcRenderTarget_.ReleaseAndGetAddressOf()));
    }

    bool CreateTextFormats() {
        if (!dwriteFactory_) {
            return false;
        }
        auto createFormat = [&](const wchar_t* family, DWRITE_FONT_WEIGHT weight,
                                int logicalPixels, ComPtr<IDWriteTextFormat>& output) {
            output.Reset();
            return SUCCEEDED(dwriteFactory_->CreateTextFormat(
                family, nullptr, weight, DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,
                static_cast<float>(ScaleValue(logicalPixels, dpi_)), L"zh-CN",
                output.GetAddressOf()));
        };

        return createFormat(L"Noto Sans SC", DWRITE_FONT_WEIGHT_SEMI_BOLD, 25, titleTextFormat_) &&
            createFormat(L"Noto Sans SC", DWRITE_FONT_WEIGHT_SEMI_BOLD, 14, sectionTextFormat_) &&
            createFormat(L"Noto Sans SC", DWRITE_FONT_WEIGHT_NORMAL, 15, bodyTextFormat_) &&
            createFormat(L"Noto Sans SC", DWRITE_FONT_WEIGHT_MEDIUM, 15, strongTextFormat_) &&
            createFormat(L"Noto Sans SC", DWRITE_FONT_WEIGHT_NORMAL, 13, smallTextFormat_) &&
            createFormat(L"Noto Sans SC", DWRITE_FONT_WEIGHT_MEDIUM, 15, buttonTextFormat_) &&
            createFormat(L"Segoe MDL2 Assets", DWRITE_FONT_WEIGHT_NORMAL, 17, iconTextFormat_);
    }

    bool BeginDirectDraw(HDC dc, const RECT& bounds) {
        if (!dcRenderTarget_ && !CreateDcRenderTarget()) {
            return false;
        }
        if (FAILED(dcRenderTarget_->BindDC(dc, &bounds))) {
            return false;
        }
        dcRenderTarget_->BeginDraw();
        activeRenderTarget_ = dcRenderTarget_.Get();
        dcRenderTarget_->SetTransform(D2D1::Matrix3x2F::Identity());
        dcRenderTarget_->SetAntialiasMode(D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
        dcRenderTarget_->SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
        dcRenderTarget_->SetTextRenderingParams(textRenderingParams_.Get());
        return true;
    }

    void EndDirectDraw() {
        if (!dcRenderTarget_) {
            return;
        }
        if (dcRenderTarget_->EndDraw() == D2DERR_RECREATE_TARGET) {
            dcRenderTarget_.Reset();
        }
        activeRenderTarget_ = nullptr;
    }

    bool BeginWindowDraw() {
        if (!hwndRenderTarget_ && !CreateHwndRenderTarget()) {
            return false;
        }
        activeRenderTarget_ = hwndRenderTarget_.Get();
        hwndRenderTarget_->BeginDraw();
        hwndRenderTarget_->SetTransform(D2D1::Matrix3x2F::Identity());
        hwndRenderTarget_->SetAntialiasMode(D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
        hwndRenderTarget_->SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
        hwndRenderTarget_->SetTextRenderingParams(textRenderingParams_.Get());
        return true;
    }

    void EndWindowDraw() {
        if (!hwndRenderTarget_) {
            activeRenderTarget_ = nullptr;
            return;
        }
        if (hwndRenderTarget_->EndDraw() == D2DERR_RECREATE_TARGET) {
            hwndRenderTarget_.Reset();
        }
        activeRenderTarget_ = nullptr;
    }

    void DrawDirectText(
        std::wstring_view text, IDWriteTextFormat* format, const RECT& rect,
        COLORREF color, DWRITE_TEXT_ALIGNMENT alignment = DWRITE_TEXT_ALIGNMENT_LEADING,
        DWRITE_PARAGRAPH_ALIGNMENT paragraph = DWRITE_PARAGRAPH_ALIGNMENT_CENTER,
        bool wrap = false) {
        if (!activeRenderTarget_ || !format || text.empty()) {
            return;
        }
        format->SetTextAlignment(alignment);
        format->SetParagraphAlignment(paragraph);
        format->SetWordWrapping(wrap ? DWRITE_WORD_WRAPPING_WRAP : DWRITE_WORD_WRAPPING_NO_WRAP);
        ComPtr<ID2D1SolidColorBrush> brush;
        if (FAILED(activeRenderTarget_->CreateSolidColorBrush(
                DirectColor(color), brush.GetAddressOf()))) {
            return;
        }
        const auto layout = D2D1::RectF(
            static_cast<float>(rect.left), static_cast<float>(rect.top),
            static_cast<float>(rect.right), static_cast<float>(rect.bottom));
        activeRenderTarget_->DrawTextW(
            text.data(), static_cast<UINT32>(text.size()), format, layout, brush.Get(),
            D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
    }

    float MeasureDirectText(std::wstring_view text, IDWriteTextFormat* format) const {
        if (!dwriteFactory_ || !format || text.empty()) {
            return 0.0F;
        }
        ComPtr<IDWriteTextLayout> layout;
        if (FAILED(dwriteFactory_->CreateTextLayout(
                text.data(), static_cast<UINT32>(text.size()), format,
                4096.0F, 256.0F, layout.GetAddressOf()))) {
            return 0.0F;
        }
        DWRITE_TEXT_METRICS metrics{};
        if (FAILED(layout->GetMetrics(&metrics))) {
            return 0.0F;
        }
        return metrics.widthIncludingTrailingWhitespace;
    }

    void DrawDirectLine(float x1, float y1, float x2, float y2, COLORREF color) {
        if (!activeRenderTarget_) {
            return;
        }
        ComPtr<ID2D1SolidColorBrush> brush;
        if (SUCCEEDED(activeRenderTarget_->CreateSolidColorBrush(
                DirectColor(color), brush.GetAddressOf()))) {
            activeRenderTarget_->DrawLine(
                D2D1::Point2F(x1, y1), D2D1::Point2F(x2, y2), brush.Get(), 1.0F);
        }
    }

    void FillDirectCircle(float centerX, float centerY, float radius, COLORREF color) {
        if (!activeRenderTarget_) {
            return;
        }
        ComPtr<ID2D1SolidColorBrush> brush;
        if (SUCCEEDED(activeRenderTarget_->CreateSolidColorBrush(
                DirectColor(color), brush.GetAddressOf()))) {
            activeRenderTarget_->FillEllipse(
                D2D1::Ellipse(D2D1::Point2F(centerX, centerY), radius, radius), brush.Get());
        }
    }

    void OnDpiChanged(WPARAM wParam, LPARAM lParam) {
        dpi_ = LOWORD(wParam);
        CreateFonts();
        CreateTextFormats();
        for (HWND button : buttonHandles_) {
            if (button != nullptr) {
                SendMessageW(button, WM_SETFONT, reinterpret_cast<WPARAM>(buttonFont_), TRUE);
            }
        }

        const auto* suggested = reinterpret_cast<RECT*>(lParam);
        SetWindowPos(
            hwnd_, nullptr, suggested->left, suggested->top,
            suggested->right - suggested->left, suggested->bottom - suggested->top,
            SWP_NOACTIVATE | SWP_NOZORDER);
        LayoutButtons();
        InvalidateRect(hwnd_, nullptr, FALSE);
    }

    void OnGetMinMaxInfo(MINMAXINFO* limits) const {
        RECT minimumRect{
            0, 0, ScaleValue(520, dpi_), ScaleValue(520, dpi_)};
        AdjustWindowRectExForDpi(
            &minimumRect, WS_OVERLAPPEDWINDOW, FALSE, 0, dpi_);
        limits->ptMinTrackSize.x = minimumRect.right - minimumRect.left;
        limits->ptMinTrackSize.y = minimumRect.bottom - minimumRect.top;
    }

    void LayoutButtons() {
        if (buttonHandles_[0] == nullptr) {
            return;
        }
        RECT client{};
        GetClientRect(hwnd_, &client);
        const int margin = ScaleValue(36, dpi_);
        const int gap = ScaleValue(12, dpi_);
        const int buttonHeight = ScaleValue(46, dpi_);
        const int firstY = ScaleValue(310, dpi_);
        const int columnWidth = (client.right - margin * 2 - gap) / 2;
        const int secondX = margin + columnWidth + gap;
        const int secondY = firstY + buttonHeight + gap;

        MoveWindow(buttonHandles_[0], margin, firstY, columnWidth, buttonHeight, TRUE);
        MoveWindow(buttonHandles_[1], secondX, firstY, columnWidth, buttonHeight, TRUE);
        MoveWindow(buttonHandles_[2], margin, secondY, columnWidth, buttonHeight, TRUE);
        MoveWindow(buttonHandles_[3], secondX, secondY, columnWidth, buttonHeight, TRUE);
    }

    void Paint() {
        PAINTSTRUCT paint{};
        BeginPaint(hwnd_, &paint);
        RECT client{};
        GetClientRect(hwnd_, &client);

        if (BeginWindowDraw()) {
            hwndRenderTarget_->Clear(DirectColor(kCanvas));
            ComPtr<ID2D1SolidColorBrush> surfaceBrush;
            if (SUCCEEDED(hwndRenderTarget_->CreateSolidColorBrush(
                    DirectColor(kSurface), surfaceBrush.GetAddressOf()))) {
                hwndRenderTarget_->FillRectangle(
                    D2D1::RectF(0.0F, 0.0F, static_cast<float>(client.right),
                                static_cast<float>(ScaleValue(86, dpi_))),
                    surfaceBrush.Get());
                hwndRenderTarget_->FillRectangle(
                    D2D1::RectF(0.0F, static_cast<float>(FooterTop(client.bottom)),
                                static_cast<float>(client.right), static_cast<float>(client.bottom)),
                    surfaceBrush.Get());
            }
            DrawHeader(client);
            DrawStatuses(client);
            DrawFooter(client);
            EndWindowDraw();
        }
        EndPaint(hwnd_, &paint);
    }

    void DrawHeader(const RECT& client) {
        const int margin = ScaleValue(36, dpi_);
        RECT titleRect{margin, ScaleValue(24, dpi_), client.right - margin, ScaleValue(60, dpi_)};
        DrawDirectText(kWindowTitle, titleTextFormat_.Get(), titleRect, kText);

        RECT timeRect{
            margin + ScaleValue(220, dpi_), ScaleValue(28, dpi_),
            client.right - margin, ScaleValue(58, dpi_)};
        DrawDirectText(
            refreshText_, smallTextFormat_.Get(), timeRect, kFaintText,
            DWRITE_TEXT_ALIGNMENT_TRAILING);

        const float dividerY = static_cast<float>(ScaleValue(85, dpi_)) + 0.5F;
        DrawDirectLine(
            static_cast<float>(margin), dividerY,
            static_cast<float>(client.right - margin), dividerY, kDivider);
    }

    void DrawStatuses(const RECT& client) {
        const int margin = ScaleValue(36, dpi_);
        RECT heading{margin, ScaleValue(100, dpi_), client.right - margin, ScaleValue(124, dpi_)};
        DrawDirectText(L"当前状态", sectionTextFormat_.Get(), heading, kText);

        const std::array<const wchar_t*, 4> labels{
            L"编辑器", L"代理模式", L"手机桥", L"公网连接"};
        const std::array<const ComponentStatus*, 4> statuses{
            &snapshot_.trae, &snapshot_.proxy, &snapshot_.bridge, &snapshot_.publicConnection};
        const int rowTop = ScaleValue(126, dpi_);
        const int rowHeight = ScaleValue(37, dpi_);
        const int statusLeft = margin + ScaleValue(122, dpi_);
        const int dotSize = ScaleValue(9, dpi_);

        for (std::size_t index = 0; index < labels.size(); ++index) {
            const int top = rowTop + static_cast<int>(index) * rowHeight;
            RECT labelRect{margin, top, statusLeft - ScaleValue(18, dpi_), top + rowHeight};
            DrawDirectText(labels[index], bodyTextFormat_.Get(), labelRect, kMutedText);

            const int dotTop = top + (rowHeight - dotSize) / 2;
            const float dotRadius = static_cast<float>(dotSize) / 2.0F;
            FillDirectCircle(
                static_cast<float>(statusLeft) + dotRadius,
                static_cast<float>(dotTop) + dotRadius,
                dotRadius, LevelColor(statuses[index]->level));

            RECT valueRect{
                statusLeft + ScaleValue(18, dpi_), top,
                client.right - margin, top + rowHeight};
            DrawDirectText(statuses[index]->text, strongTextFormat_.Get(), valueRect, kText);

            if (index + 1 < labels.size()) {
                const float lineY = static_cast<float>(top + rowHeight - 1) + 0.5F;
                DrawDirectLine(
                    static_cast<float>(statusLeft), lineY,
                    static_cast<float>(client.right - margin), lineY, kDivider);
            }
        }

        RECT controlsHeading{
            margin, ScaleValue(278, dpi_), client.right - margin, ScaleValue(302, dpi_)};
        DrawDirectText(L"服务控制", sectionTextFormat_.Get(), controlsHeading, kText);
    }

    void DrawFooter(const RECT& client) {
        const int margin = ScaleValue(36, dpi_);
        const int top = FooterTop(client.bottom);
        const float lineY = static_cast<float>(top) + 0.5F;
        DrawDirectLine(0.0F, lineY, static_cast<float>(client.right), lineY, kDivider);

        RECT heading{
            margin, top + ScaleValue(15, dpi_),
            client.right - margin, top + ScaleValue(39, dpi_)};
        DrawDirectText(L"最近操作", sectionTextFormat_.Get(), heading, kText);

        RECT message{
            margin, top + ScaleValue(42, dpi_),
            client.right - margin, client.bottom - ScaleValue(13, dpi_)};
        DrawDirectText(
            recentAction_, bodyTextFormat_.Get(), message,
            recentActionError_ ? kRed : kMutedText,
            DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_PARAGRAPH_ALIGNMENT_NEAR, true);
    }

    int FooterTop(int clientHeight) const {
        return (std::max)(ScaleValue(424, dpi_), clientHeight - ScaleValue(108, dpi_));
    }

    bool DrawButton(const DRAWITEMSTRUCT* item) {
        if (item == nullptr || item->CtlType != ODT_BUTTON) {
            return false;
        }
        const HDC destinationDc = item->hDC;
        const RECT destinationRect = item->rcItem;
        const int width = destinationRect.right - destinationRect.left;
        const int height = destinationRect.bottom - destinationRect.top;
        HDC bufferDc = CreateCompatibleDC(destinationDc);
        HBITMAP bufferBitmap = CreateCompatibleBitmap(destinationDc, width, height);
        if (!bufferDc || !bufferBitmap) {
            if (bufferBitmap) DeleteObject(bufferBitmap);
            if (bufferDc) DeleteDC(bufferDc);
            return false;
        }
        HGDIOBJ previousBitmap = SelectObject(bufferDc, bufferBitmap);
        DRAWITEMSTRUCT bufferedItem = *item;
        bufferedItem.hDC = bufferDc;
        bufferedItem.rcItem = RECT{0, 0, width, height};
        item = &bufferedItem;

        const bool primary = item->CtlID == kEnableButton || item->CtlID == kRestartButton;
        const bool disabled = (item->itemState & ODS_DISABLED) != 0;
        const bool pressed = (item->itemState & ODS_SELECTED) != 0;
        const bool focused = (item->itemState & ODS_FOCUS) != 0;
        const bool hovered = GetPropW(item->hwndItem, L"CodexPhoneAssistantHover") != nullptr;
        const bool spinning = actionInProgress_ && activeButtonId_ == static_cast<int>(item->CtlID);

        COLORREF background = primary ? kAccent : kSurface;
        COLORREF border = primary ? kAccent : RGB(202, 210, 220);
        COLORREF foreground = primary ? kSurface : kText;
        if (disabled) {
            if (spinning) {
                background = kAccentSoft;
                border = RGB(174, 199, 248);
                foreground = kAccent;
            } else {
                background = RGB(241, 243, 246);
                border = RGB(222, 226, 232);
                foreground = RGB(154, 162, 172);
            }
        } else if (pressed) {
            background = primary ? kAccentPressed : RGB(231, 235, 240);
            border = primary ? kAccentPressed : RGB(174, 184, 196);
        } else if (hovered) {
            background = primary ? kAccentHover : RGB(247, 249, 252);
            border = primary ? kAccentHover : RGB(157, 170, 185);
        }

        RECT bufferRect{0, 0, width, height};
        HBRUSH canvasBrush = CreateSolidBrush(kCanvas);
        FillRect(bufferDc, &bufferRect, canvasBrush);
        DeleteObject(canvasBrush);

        wchar_t label[128]{};
        GetWindowTextW(item->hwndItem, label, static_cast<int>(std::size(label)));
        const std::wstring_view labelText(label);
        int textWidth = static_cast<int>(std::ceil(
            MeasureDirectText(labelText, buttonTextFormat_.Get())));
        if (textWidth <= 0) {
            SelectObject(item->hDC, buttonFont_);
            SIZE fallbackSize{};
            GetTextExtentPoint32W(
                item->hDC, label, static_cast<int>(labelText.size()), &fallbackSize);
            textWidth = fallbackSize.cx;
        }
        const int iconSize = ScaleValue(18, dpi_);
        const int iconGap = ScaleValue(9, dpi_);
        const int contentWidth = textWidth + iconSize + iconGap;
        int textLeft = item->rcItem.left + (item->rcItem.right - item->rcItem.left - contentWidth) / 2;
        const bool directDraw = BeginDirectDraw(item->hDC, item->rcItem);
        if (directDraw) {
            ComPtr<ID2D1SolidColorBrush> backgroundBrush;
            ComPtr<ID2D1SolidColorBrush> borderBrush;
            activeRenderTarget_->CreateSolidColorBrush(
                DirectColor(background), backgroundBrush.GetAddressOf());
            activeRenderTarget_->CreateSolidColorBrush(
                DirectColor(border), borderBrush.GetAddressOf());
            const float inset = 0.5F;
            const float radius = static_cast<float>(ScaleValue(4, dpi_));
            const auto rounded = D2D1::RoundedRect(
                D2D1::RectF(inset, inset, static_cast<float>(width) - inset,
                            static_cast<float>(height) - inset),
                radius, radius);
            activeRenderTarget_->FillRoundedRectangle(rounded, backgroundBrush.Get());
            activeRenderTarget_->DrawRoundedRectangle(rounded, borderBrush.Get(), 1.0F);

            const float iconLeft = static_cast<float>(textLeft);
            const float iconTop = static_cast<float>((height - iconSize) / 2);
            if (spinning) {
                DrawVectorSpinner(iconLeft, iconTop, static_cast<float>(iconSize), foreground);
            } else {
                DrawVectorButtonIcon(
                    item->CtlID, iconLeft, iconTop, static_cast<float>(iconSize), foreground);
            }
        }
        textLeft += iconSize + iconGap;
        RECT textRect{
            textLeft, item->rcItem.top,
            textLeft + textWidth + ScaleValue(2, dpi_), item->rcItem.bottom};
        if (directDraw) {
            DrawDirectText(labelText, buttonTextFormat_.Get(), textRect, foreground);
            if (focused) {
                ComPtr<ID2D1SolidColorBrush> focusBrush;
                activeRenderTarget_->CreateSolidColorBrush(
                    DirectColor(foreground), focusBrush.GetAddressOf());
                const float focusInset = static_cast<float>(ScaleValue(4, dpi_)) + 0.5F;
                activeRenderTarget_->DrawRoundedRectangle(
                    D2D1::RoundedRect(
                        D2D1::RectF(focusInset, focusInset,
                                    static_cast<float>(width) - focusInset,
                                    static_cast<float>(height) - focusInset),
                        2.0F, 2.0F),
                    focusBrush.Get(), 1.0F);
            }
            EndDirectDraw();
        } else {
            SelectObject(item->hDC, buttonFont_);
            SetBkMode(item->hDC, TRANSPARENT);
            SetTextColor(item->hDC, foreground);
            DrawTextW(
                item->hDC, label, -1, &textRect,
                DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
        }

        BitBlt(
            destinationDc, destinationRect.left, destinationRect.top,
            width, height, bufferDc, 0, 0, SRCCOPY);
        SelectObject(bufferDc, previousBitmap);
        DeleteObject(bufferBitmap);
        DeleteDC(bufferDc);
        return true;
    }

    void DrawVectorArc(
        float centerX, float centerY, float radius, float startDegrees,
        float sweepDegrees, ID2D1Brush* brush, float strokeWidth) {
        if (!activeRenderTarget_ || !d2dFactory_ || !brush) return;
        constexpr float pi = 3.14159265358979323846F;
        const auto pointAt = [&](float degrees) {
            const float radians = degrees * pi / 180.0F;
            return D2D1::Point2F(
                centerX + std::cos(radians) * radius,
                centerY + std::sin(radians) * radius);
        };
        ComPtr<ID2D1PathGeometry> geometry;
        ComPtr<ID2D1GeometrySink> sink;
        if (FAILED(d2dFactory_->CreatePathGeometry(geometry.GetAddressOf())) ||
            FAILED(geometry->Open(sink.GetAddressOf()))) return;
        sink->BeginFigure(pointAt(startDegrees), D2D1_FIGURE_BEGIN_HOLLOW);
        sink->AddArc(D2D1::ArcSegment(
            pointAt(startDegrees + sweepDegrees), D2D1::SizeF(radius, radius),
            0.0F, sweepDegrees >= 0.0F ? D2D1_SWEEP_DIRECTION_CLOCKWISE
                                       : D2D1_SWEEP_DIRECTION_COUNTER_CLOCKWISE,
            std::abs(sweepDegrees) > 180.0F ? D2D1_ARC_SIZE_LARGE : D2D1_ARC_SIZE_SMALL));
        sink->EndFigure(D2D1_FIGURE_END_OPEN);
        if (SUCCEEDED(sink->Close())) {
            activeRenderTarget_->DrawGeometry(geometry.Get(), brush, strokeWidth);
        }
    }

    void DrawVectorButtonIcon(UINT controlId, float left, float top, float size, COLORREF color) {
        if (!activeRenderTarget_) return;
        ComPtr<ID2D1SolidColorBrush> brush;
        if (FAILED(activeRenderTarget_->CreateSolidColorBrush(
                DirectColor(color), brush.GetAddressOf()))) return;
        const float cx = left + size / 2.0F;
        const float cy = top + size / 2.0F;
        const float radius = size * 0.39F;
        const float stroke = (std::max)(1.5F, static_cast<float>(ScaleValue(1, dpi_)));
        if (controlId == kEnableButton) {
            DrawVectorArc(cx, cy, radius, -45.0F, 270.0F, brush.Get(), stroke);
            activeRenderTarget_->DrawLine(
                D2D1::Point2F(cx, top + size * 0.06F),
                D2D1::Point2F(cx, cy), brush.Get(), stroke);
        } else if (controlId == kDisableButton) {
            const float inset = size * 0.22F;
            activeRenderTarget_->DrawLine(
                D2D1::Point2F(left + inset, top + inset),
                D2D1::Point2F(left + size - inset, top + size - inset), brush.Get(), stroke);
            activeRenderTarget_->DrawLine(
                D2D1::Point2F(left + size - inset, top + inset),
                D2D1::Point2F(left + inset, top + size - inset), brush.Get(), stroke);
        } else if (controlId == kRestartButton) {
            DrawVectorArc(cx, cy, radius, 200.0F, 140.0F, brush.Get(), stroke);
            DrawVectorArc(cx, cy, radius, 20.0F, 140.0F, brush.Get(), stroke);
            constexpr float pi = 3.14159265358979323846F;
            const auto drawArrow = [&](float degrees) {
                const float radians = degrees * pi / 180.0F;
                const D2D1_POINT_2F tip{
                    cx + std::cos(radians) * radius,
                    cy + std::sin(radians) * radius};
                const D2D1_POINT_2F tangent{-std::sin(radians), std::cos(radians)};
                const D2D1_POINT_2F normal{-tangent.y, tangent.x};
                const float arrowLength = size * 0.24F;
                const float arrowHalfWidth = size * 0.13F;
                const D2D1_POINT_2F base{
                    tip.x - tangent.x * arrowLength,
                    tip.y - tangent.y * arrowLength};
                activeRenderTarget_->DrawLine(
                    tip,
                    D2D1::Point2F(
                        base.x + normal.x * arrowHalfWidth,
                        base.y + normal.y * arrowHalfWidth),
                    brush.Get(), stroke);
                activeRenderTarget_->DrawLine(
                    tip,
                    D2D1::Point2F(
                        base.x - normal.x * arrowHalfWidth,
                        base.y - normal.y * arrowHalfWidth),
                    brush.Get(), stroke);
            };
            drawArrow(340.0F);
            drawArrow(160.0F);
        } else {
            const float inset = size * 0.22F;
            activeRenderTarget_->DrawRectangle(
                D2D1::RectF(left + inset, top + inset,
                            left + size - inset, top + size - inset),
                brush.Get(), stroke);
        }
    }

    void DrawVectorSpinner(float left, float top, float size, COLORREF color) {
        if (!activeRenderTarget_) return;
        ComPtr<ID2D1SolidColorBrush> brush;
        if (FAILED(activeRenderTarget_->CreateSolidColorBrush(
                DirectColor(color), brush.GetAddressOf()))) return;
        DrawVectorArc(
            left + size / 2.0F, top + size / 2.0F, size * 0.39F,
            static_cast<float>(spinnerAngle_), 270.0F, brush.Get(),
            (std::max)(1.5F, static_cast<float>(ScaleValue(1, dpi_))));
    }

    void OnButtonClicked(int buttonId) {
        if (actionInProgress_) {
            return;
        }

        ManagerAction action;
        switch (buttonId) {
            case kEnableButton:
                action = ManagerAction::Enable;
                break;
            case kDisableButton:
                if (MessageBoxW(
                        hwnd_,
                        L"关闭代理模式会恢复 Trae 和 VS Code 各自原来的 CLI 设置，并停止手机桥。\n\n确定继续吗？",
                        L"确认关闭代理模式",
                        MB_ICONWARNING | MB_YESNO | MB_DEFBUTTON2) != IDYES) {
                    return;
                }
                action = ManagerAction::Disable;
                break;
            case kRestartButton:
                action = ManagerAction::Restart;
                break;
            case kStopButton:
                action = ManagerAction::Stop;
                break;
            default:
                return;
        }

        actionInProgress_ = true;
        activeButtonId_ = buttonId;
        pendingAction_ = action;
        recentActionError_ = false;
        recentAction_ = L"正在执行：" + ActionDisplayName(action);
        SetButtonsEnabled(false);
        SetTimer(hwnd_, kSpinnerTimer, 50, nullptr);
        InvalidateRect(hwnd_, nullptr, FALSE);

        if (!requestInFlight_) {
            StartPendingAction();
        }
    }

    static std::wstring ActionDisplayName(ManagerAction action) {
        switch (action) {
            case ManagerAction::Enable:
                return L"开启代理模式";
            case ManagerAction::Disable:
                return L"关闭代理模式";
            case ManagerAction::Restart:
                return L"启动/重启手机桥";
            case ManagerAction::Stop:
                return L"结束手机桥";
            case ManagerAction::Status:
                return L"刷新状态";
        }
        return L"操作";
    }

    void SetButtonsEnabled(bool enabled) {
        for (HWND button : buttonHandles_) {
            if (button != nullptr) {
                EnableWindow(button, enabled ? TRUE : FALSE);
                InvalidateRect(button, nullptr, FALSE);
            }
        }
    }

    void BeginStatusRefresh() {
        if (closing_ || requestInFlight_ || actionInProgress_) {
            return;
        }
        StartRequest(ManagerAction::Status);
    }

    void StartPendingAction() {
        if (!pendingAction_.has_value() || requestInFlight_) {
            return;
        }
        const ManagerAction action = *pendingAction_;
        pendingAction_.reset();
        StartRequest(action);
    }

    void StartRequest(ManagerAction action) {
        requestInFlight_ = true;
        const HWND targetWindow = hwnd_;
        const auto timeout = action == ManagerAction::Status
            ? std::chrono::seconds(15)
            : std::chrono::seconds(120);
        std::thread([targetWindow, action, timeout] {
            auto result = std::make_unique<ManagerResult>(
                phone_assistant::RunManager(action, timeout));
            if (!PostMessageW(
                    targetWindow, kManagerCompletedMessage, 0,
                    reinterpret_cast<LPARAM>(result.get()))) {
                return;
            }
            result.release();
        }).detach();
    }

    void OnManagerCompleted(std::unique_ptr<ManagerResult> result) {
        requestInFlight_ = false;
        if (!result) {
            return;
        }

        const bool processOk = result->processStarted && result->exitCode == 0 && !result->timedOut;
        if (!result->processStarted) {
            const std::wstring message = result->processError.empty()
                ? L"无法启动手机桥管理器"
                : result->processError;
            result->snapshot.trae = {message, StatusLevel::Error};
            result->snapshot.proxy = {message, StatusLevel::Error};
            result->snapshot.bridge = {message, StatusLevel::Error};
            result->snapshot.publicConnection = {message, StatusLevel::Error};
        }
        snapshot_ = result->snapshot;

        if (result->action == ManagerAction::Status) {
            refreshText_ = TimeText(processOk);
            if (!processOk) {
                recentActionError_ = true;
                recentAction_ = !result->processError.empty()
                    ? result->processError
                    : (!result->snapshot.message.empty()
                        ? result->snapshot.message
                        : L"状态刷新失败，稍后自动重试");
            } else if (
                !result->snapshot.recentAction.empty() &&
                std::chrono::steady_clock::now() >= preserveRecentActionUntil_) {
                recentActionError_ = false;
                recentAction_ = result->snapshot.recentAction;
            } else if (recentAction_ == L"正在读取手机桥状态...") {
                recentAction_ = L"手机桥状态已更新";
            }

            InvalidateRect(hwnd_, nullptr, FALSE);
            if (actionInProgress_ && pendingAction_.has_value()) {
                StartPendingAction();
            }
            return;
        }

        const bool actionSucceeded = processOk && result->snapshot.operationSuccess;
        recentActionError_ = !actionSucceeded;
        if (!result->snapshot.message.empty()) {
            recentAction_ = result->snapshot.message;
        } else if (!result->processError.empty()) {
            recentAction_ = result->processError;
        } else {
            recentAction_ = DefaultActionMessage(result->action, actionSucceeded);
            if (!actionSucceeded && result->exitCode != 0) {
                recentAction_ += L"（退出代码 " + std::to_wstring(result->exitCode) + L"）";
            }
        }

        actionInProgress_ = false;
        activeButtonId_ = 0;
        preserveRecentActionUntil_ = std::chrono::steady_clock::now() + std::chrono::seconds(3);
        KillTimer(hwnd_, kSpinnerTimer);
        SetButtonsEnabled(true);
        InvalidateRect(hwnd_, nullptr, FALSE);
        if (closeAfterAction_) {
            DestroyWindow(hwnd_);
            return;
        }
        BeginStatusRefresh();
    }

    void OnTimer(WPARAM timerId) {
        if (timerId == kRefreshTimer) {
            BeginStatusRefresh();
        } else if (timerId == kSpinnerTimer && actionInProgress_) {
            spinnerAngle_ = (spinnerAngle_ + 18) % 360;
            for (HWND button : buttonHandles_) {
                if (button != nullptr && GetDlgCtrlID(button) == activeButtonId_) {
                    InvalidateRect(button, nullptr, FALSE);
                    break;
                }
            }
        }
    }

    HINSTANCE instance_ = nullptr;
    HWND hwnd_ = nullptr;
    UINT dpi_ = 96;
    std::array<HWND, 4> buttonHandles_{};

    HFONT titleFont_ = nullptr;
    HFONT sectionFont_ = nullptr;
    HFONT bodyFont_ = nullptr;
    HFONT bodyStrongFont_ = nullptr;
    HFONT smallFont_ = nullptr;
    HFONT buttonFont_ = nullptr;
    HFONT iconFont_ = nullptr;

    ComPtr<ID2D1Factory> d2dFactory_;
    ComPtr<IDWriteFactory> dwriteFactory_;
    ComPtr<ID2D1HwndRenderTarget> hwndRenderTarget_;
    ComPtr<ID2D1DCRenderTarget> dcRenderTarget_;
    ComPtr<IDWriteRenderingParams> textRenderingParams_;
    ID2D1RenderTarget* activeRenderTarget_ = nullptr;
    ComPtr<IDWriteTextFormat> titleTextFormat_;
    ComPtr<IDWriteTextFormat> sectionTextFormat_;
    ComPtr<IDWriteTextFormat> bodyTextFormat_;
    ComPtr<IDWriteTextFormat> strongTextFormat_;
    ComPtr<IDWriteTextFormat> smallTextFormat_;
    ComPtr<IDWriteTextFormat> buttonTextFormat_;
    ComPtr<IDWriteTextFormat> iconTextFormat_;

    ManagerSnapshot snapshot_{};
    std::wstring refreshText_ = L"等待首次刷新";
    std::wstring recentAction_ = L"正在读取手机桥状态...";
    bool recentActionError_ = false;

    bool requestInFlight_ = false;
    bool actionInProgress_ = false;
    bool closing_ = false;
    bool closeAfterAction_ = false;
    int activeButtonId_ = 0;
    int spinnerAngle_ = 0;
    std::optional<ManagerAction> pendingAction_;
    std::chrono::steady_clock::time_point preserveRecentActionUntil_{};
};

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int showCommand) {
    int argumentCount = 0;
    const auto arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
    if (!arguments) return 1;
    std::vector<std::wstring> commandArguments;
    for (int i = 1; i < argumentCount; ++i) commandArguments.emplace_back(arguments[i]);
    LocalFree(arguments);
    if (!commandArguments.empty()) return phone_assistant::management::CommandMain(commandArguments);
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_STANDARD_CLASSES};
    InitCommonControlsEx(&controls);

    PhoneAssistantWindow application(instance);
    if (!application.CreateAndShow(showCommand)) {
        MessageBoxW(
            nullptr, L"Codex手机助手窗口创建失败。", kWindowTitle,
            MB_OK | MB_ICONERROR);
        return 1;
    }

    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    return static_cast<int>(message.wParam);
}
