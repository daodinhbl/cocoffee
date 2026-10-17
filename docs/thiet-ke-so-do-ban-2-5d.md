# Thiết kế: Sơ đồ bàn 2.5D tương tác (Interactive Floor Plan)

Ngày soạn: 17/10/2026. Phạm vi: app Flutter POS (`mobile/`, Riverpod 3 + go_router + sqflite offline-first), backend Node.js/Express, MySQL trên Hostinger.
Bám theo hiện trạng: bảng `dining_tables`, `media_files` + `/media/<id>-<slug>.<ext>` (cache `immutable`), `snapshot_sync` của app, màn `features/tables/`.

**Kết luận ngắn (khuyến nghị):**
1. Render bằng **`Transform` + `Matrix4` trên sprite 2.5D dựng sẵn** (PNG/WebP), không dùng engine 3D. `flutter_3d_controller` (WebView + model-viewer) và Flame (game loop liên tục) đều quá nặng cho máy yếu và không có lợi với ≤ 50 bàn.
2. **Sửa bố cục ở chế độ nhìn từ trên xuống (không phối cảnh)**, **xem/vận hành ở chế độ nghiêng 2.5D**. Việc này loại bỏ gần hết độ phức tạp của kéo thả dưới phối cảnh.
3. Tọa độ lưu **chuẩn hóa theo ảnh mặt bằng (0..1)**, kích thước theo **tỷ lệ chiều rộng ảnh**, nên đúng trên mọi màn hình mà không cần quy đổi theo thiết bị.
4. Ảnh nén ở **phía app** trước khi upload (≤ 2400 px, ≤ ~800 KB), server chỉ kiểm tra và lưu; app cache file theo `media id` (bất biến).

---

## 1. Luồng người dùng → thành phần

| Bước | Hành động | Thành phần |
|---|---|---|
| 1 Setup | Chọn ảnh 2D, cắt/xoay, upload | `FloorPlanSetupScreen` → nén tại app → `POST /api/floor-plans` |
| 2 Render | Hiển thị nền + hiệu ứng nghiêng | `FloorStage` (nền) + `TiltScene` (ma trận) |
| 3 Interact | Kéo bàn từ thanh công cụ vào mặt bằng | `Draggable<TableKind>` + `DragTarget`, hoặc giữ-kéo bàn có sẵn |
| 4 Config | Chạm bàn → số bàn, loại bàn | `TableConfigSheet` (dùng lại `table_sheet.dart`) |
| 5 Save | Lưu tọa độ, tỷ lệ, góc xoay | `PUT /api/floor-plans/:id/layout` (có `version`) |

---

## 2. Render & hiệu năng (Flutter)

### 2.1 So sánh phương án

| Phương án | Hình ảnh | Hiệu năng máy yếu | Kéo thả/hit-test | Chi phí làm | Kết luận |
|---|---|---|---|---|---|
| **A. Matrix4 + sprite 2.5D** | Isometric giả bằng sprite vẽ sẵn, nghiêng cả cảnh | Tốt: bàn là ảnh tĩnh, GPU chỉ ghép lớp | `Transform` hit-test chuẩn, tự kiểm soát | Thấp, cần bộ sprite (1 lần) | **Chọn** |
| B. CustomPainter vẽ khối | Hộp isometric vẽ bằng `Path` | Tốt | Phải tự hit-test | Trung bình | Dự phòng khi không có sprite |
| C. `flutter_3d_controller` | Model 3D thật (glTF) | Kém: mỗi model một WebView + WebGL, RAM lớn, khởi động chậm | Khó (WebView nuốt cử chỉ) | Cao + phụ thuộc WebView | Loại |
| D. Flame | Game engine | Vòng lặp vẽ 60 fps liên tục → hao pin, nóng | Có | Cao | Loại (quá mức cho UI tĩnh) |

### 2.2 Cấu trúc cây widget

```
InteractiveViewer (zoom/pan)                     ← 1 transformationController dùng chung
└─ SizedBox(planW × planH)  // "không gian cảnh" cố định, vd 2000 × 1200 (tỉ lệ ảnh)
   └─ TiltScene(tilt: 0..1)                      ← xoay phối cảnh cả cảnh, không đụng logic tọa độ
      └─ Stack
         ├─ Image(background, cacheWidth: 2048)  ← RepaintBoundary
         └─ for table in tables: TableSprite     ← RepaintBoundary, mỗi bàn
```

### 2.3 Hiệu ứng nghiêng bằng Matrix4

```dart
/// tilt = 0 (nhìn từ trên xuống) … 1 (nghiêng ~50°). Animate bằng TweenAnimationBuilder.
Matrix4 sceneMatrix(double tilt, Size plan) {
  final m = Matrix4.identity()
    ..setEntry(3, 2, 0.0008 * tilt)                 // phối cảnh nhẹ
    ..translate(plan.width / 2, plan.height / 2)    // xoay quanh tâm
    ..rotateX(tilt * 0.87)                          // ~50°
    ..translate(-plan.width / 2, -plan.height / 2);
  return m;
}

/// Sprite bàn đứng thẳng ("billboard"): bù góc nghiêng quanh điểm chạm sàn (đáy giữa).
Widget billboard(double tilt, Offset anchor, Widget child) => Transform(
  transform: Matrix4.identity()..rotateX(-tilt * 0.87),
  alignment: Alignment.bottomCenter,
  child: child,
);
```

Điểm chạm sàn (anchor) của sprite = **đáy giữa** ảnh sprite; `pos_x/pos_y` lưu **điểm chạm sàn**, không phải tâm sprite. Nhờ vậy bàn không "trôi" khi đổi độ nghiêng và thứ tự che khuất đúng (xem `z` ở 4.2).

### 2.4 Tối ưu cho máy yếu

| Việc | Cách làm |
|---|---|
| Ảnh nền | `ResizeImage`/`cacheWidth: 2048`, không giải mã ở độ phân giải gốc; `FilterQuality.low` khi đang pan/zoom, `medium` khi dừng |
| Sprite | Dựng sẵn 4–6 loại × 1 tông màu, PNG/WebP ≤ 20 KB, `precacheImage` lúc vào màn; trạng thái bàn (trống/đang phục vụ/ghép) đổi bằng viền/chấm màu vẽ ngoài sprite, **không** nhân đôi sprite theo màu |
| Lớp vẽ | `RepaintBoundary` quanh nền và từng bàn; tránh `Opacity`, `ClipRRect`, `BackdropFilter`, bóng đổ mờ lớn (gây `saveLayer`) → bóng dùng ảnh elip dựng sẵn |
| Nghiêng | Chỉ animate ma trận (ở cấp compositor), không rebuild danh sách bàn; ngưỡng ≤ 60 bàn |
| Nhãn bàn | Vẽ bằng `Text` nhẹ; ẩn khi `scale` < 0,6, hiện số bàn tối giản |
| Đo thực tế | Mục tiêu ≥ 50 fps trên máy ~3 GB RAM; đo bằng DevTools (Raster thread < 12 ms) trước khi chốt |

---

## 3. Tương tác: kéo thả + zoom/pan không xung đột

### 3.1 Nguyên tắc

- **Hai chế độ rõ ràng** (không đoán ý người dùng):
  - *Xem/Vận hành*: `InteractiveViewer` pan/zoom; chạm bàn → mở đơn (hành vi hiện tại của POS).
  - *Chỉnh sửa*: chạm bàn để chọn; **kéo bàn** để di chuyển; kéo vùng trống hoặc hai ngón để pan/zoom.
- Trong chế độ chỉnh sửa **tắt phối cảnh** (`tilt = 0`), nên phép đổi tọa độ chỉ còn tịnh tiến + tỉ lệ của `InteractiveViewer`, không cần nghịch đảo phối cảnh.

### 3.2 Phân xử cử chỉ

Cử chỉ nào "thắng" được quyết định ở *gesture arena*. Cách ổn định nhất là **tắt pan của `InteractiveViewer` ngay khi một ngón chạm xuống bàn**, và **trả lại** khi có ngón thứ hai:

```dart
class EditorGestures extends StatefulWidget { /* … */ }

class _S extends State<EditorGestures> {
  final tc = TransformationController();
  final _pointers = <int>{};
  String? dragging;                         // id bàn đang kéo
  bool get panEnabled => dragging == null;  // ngón đang kéo bàn → không pan nền

  @override
  Widget build(_) => Listener(
    onPointerDown: (e) => _pointers.add(e.pointer),
    onPointerUp:   (e) => _pointers.remove(e.pointer),
    onPointerCancel: (e) => _pointers.remove(e.pointer),
    child: InteractiveViewer(
      transformationController: tc,
      panEnabled: panEnabled,               // scaleEnabled luôn true: 2 ngón vẫn zoom được
      minScale: 0.5, maxScale: 4,
      boundaryMargin: const EdgeInsets.all(200),
      child: Stack(children: [ background, ...tables.map(_tableHandle) ]),
    ),
  );

  Widget _tableHandle(TableItem t) => Positioned(
    left: t.x * plan.width - t.hit / 2, top: t.y * plan.height - t.hit,   // x,y = điểm chạm sàn
    child: GestureDetector(
      behavior: HitTestBehavior.opaque,
      onPanStart: (_) { if (_pointers.length == 1) setState(() => dragging = t.id); },
      onPanUpdate: (d) {
        if (dragging != t.id) return;
        if (_pointers.length > 1) { setState(() => dragging = null); return; }  // thêm ngón → nhường zoom
        // delta (px màn hình) → delta (đơn vị cảnh): chia cho hệ số zoom hiện tại
        final k = tc.value.getMaxScaleOnAxis();
        notifier.moveBy(t.id, d.delta / k);                // clamp trong [0,1] + snap
      },
      onPanEnd: (_) => setState(() => dragging = null),
      onTap: () => notifier.select(t.id),
    ),
  );
}
```

Điểm cốt lõi:

| Tình huống | Kết quả |
|---|---|
| 1 ngón kéo trên bàn | Kéo bàn, nền đứng yên (`panEnabled = false`) |
| 1 ngón kéo trên nền trống | Pan nền (`panEnabled = true`) |
| 2 ngón bất kỳ | Zoom/pan nền; nếu đang kéo bàn thì hủy kéo (`_pointers.length > 1`) |
| Kéo từ thanh công cụ | `Draggable` dùng `LongPressDraggable` trên điện thoại (tránh cuộn thanh công cụ nhầm), `Draggable` trên iPad |

### 3.3 Đổi tọa độ chạm → tọa độ cảnh → chuẩn hóa

Dùng khi thả từ thanh công cụ (`DragTarget.onAcceptWithDetails`):

```dart
Offset toNormalized(Offset globalPos, BuildContext viewerCtx, Size plan, TransformationController tc) {
  final local = (viewerCtx.findRenderObject() as RenderBox).globalToLocal(globalPos);
  final scene = tc.toScene(local);                       // bù zoom/pan của InteractiveViewer
  return Offset((scene.dx / plan.width).clamp(0.0, 1.0),
                (scene.dy / plan.height).clamp(0.0, 1.0));
}
```

### 3.4 Quản lý trạng thái (Riverpod, khớp app hiện tại)

```dart
@immutable
class FloorEditorState {
  final FloorPlan plan;                    // ảnh, kích thước ảnh, version
  final Map<String, TableItem> items;      // id → vị trí/xoay/tỉ lệ/loại
  final String? selectedId;
  final bool editing, dirty;
  final List<Map<String, TableItem>> undo, redo;   // tối đa ~30 bước
}
class FloorEditor extends Notifier<FloorEditorState> { /* moveBy, rotate, scale, add, remove, undo, save */ }
```

- Mỗi lần thả/kết thúc kéo mới đẩy một bước vào `undo` (không đẩy theo từng `onPanUpdate`).
- Chỉ `TableSprite` đang kéo rebuild (`select` theo id) → mượt trên máy yếu.
- Lưu **tường minh** (nút "Lưu") + cảnh báo khi thoát với `dirty`; lưu nháp cục bộ (sqflite) để không mất khi app bị tắt.

---

## 4. Dữ liệu (MySQL + JSON)

### 4.1 Bảng

| Bảng | Cột | Ghi chú |
|---|---|---|
| `floor_plans` | `id`, `name`, `image_media_id` (FK `media_files`), `thumb_media_id` NULL, `image_w` INT, `image_h` INT, `tilt_default` DECIMAL(3,2), `version` INT, `is_active` TINYINT, `updated_by`, `updated_at` | Đơn vị cảnh = pixel ảnh gốc; `version` tăng mỗi lần lưu |
| `table_kinds` | `id`, `code` (`sq2`,`sq4`,`round4`,`bar`…), `name`, `seats`, `sprite_key`, `base_w` DECIMAL(5,4) | `base_w` = bề rộng bàn / bề rộng ảnh (vd 0.045), không phải pixel |
| `dining_tables` (**thêm cột**) | `floor_plan_id` NULL, `kind_id` NULL, `pos_x` DECIMAL(7,6), `pos_y` DECIMAL(7,6), `rotation` SMALLINT (độ, 0–359), `scale` DECIMAL(4,2) DEFAULT 1.00, `z_order` SMALLINT | Giữ nguyên `code`, `name`, `capacity`, `status`, `current_order_id`, `merged_into` → mọi tính năng cũ (ghép/tách bàn, hóa đơn) chạy tiếp. Bàn chưa đặt lên mặt bằng có `pos_x` NULL (vẫn hiện ở danh sách) |

Chỉ mục: `dining_tables (floor_plan_id)`. Không cần bảng riêng cho "item" vì bàn chính là item.

### 4.2 Quy ước tọa độ

- `pos_x, pos_y ∈ [0,1]` **so với kích thước ảnh gốc**, gốc ở góc trên trái, là **điểm chạm sàn** (đáy giữa sprite).
- Kích thước hiển thị: `w = kind.base_w × scale × image_w` (đơn vị cảnh); chiều cao theo tỉ lệ sprite.
- Thứ tự che khuất: sắp theo `pos_y` tăng dần (bàn phía trước vẽ sau); `z_order` chỉ để ép tay khi cần.
- Xoay `rotation` quanh điểm chạm sàn, áp **trước** bước billboard.

### 4.3 JSON

```json
GET /api/floor-plans/active   (ETag: "v12")
{
  "id": 1, "version": 12, "name": "Tầng trệt",
  "image": { "url": "/media/57-mat-bang.jpg", "w": 2400, "h": 1440, "thumb": "/media/58-mat-bang-t.jpg" },
  "tilt_default": 0.6,
  "kinds": [ { "id": 1, "code": "sq4", "name": "Bàn 4", "seats": 4, "sprite": "sq4", "base_w": 0.045 } ],
  "tables": [
    { "id": 3, "code": "B03", "name": "Bàn 3", "kind_id": 1,
      "x": 0.412500, "y": 0.633000, "rotation": 90, "scale": 1.10, "z": 0,
      "status": "serving", "order_id": 42, "merged_into": null }
  ]
}

PUT /api/floor-plans/1/layout     body: { "version": 12, "tables": [ { "id":3, "kind_id":1, "x":…, "y":…, "rotation":90, "scale":1.1, "z":0 } ] }
→ 200 { "version": 13 }          ·  409 { "code":"STALE_LAYOUT", "version": 13 }  khi thiết bị khác đã lưu trước
```

`PUT` chạy trong một transaction, chỉ ghi các cột bố cục (không đụng `status`, `current_order_id`), xác thực `0 ≤ x,y ≤ 1`, `scale ∈ [0.4, 3]`, `rotation ∈ [0,359]`, kiểm tra bàn thuộc đúng mặt bằng.

### 4.4 Bài toán đa màn hình (Responsive)

**Nguyên nhân sai lệch thường gặp:** lưu pixel theo màn hình thiết bị đang chỉnh. **Cách tránh triệt để:**

1. Lưu **tỷ lệ theo ảnh** (mục 4.2), không bao giờ lưu pixel màn hình hay dp.
2. Cảnh là một khung **cố định theo tỉ lệ ảnh** (`planW × planH`) đặt trong `FittedBox(BoxFit.contain)`/`InteractiveViewer` → mọi thiết bị thấy cùng một bố cục, chỉ khác độ phóng đại.
3. Kích thước bàn tính theo `image_w` (4.2), nên bàn luôn đúng tỉ lệ với ảnh nền kể cả khi đổi thiết bị.
4. **Độ phóng đại khởi tạo** = vừa khít chiều rộng (điện thoại dọc) hoặc vừa khít cả ảnh (iPad ngang): `initialScale = min(viewW/planW, viewH/planH)` với máy tablet; `viewW/planW` với điện thoại, rồi cho pan.
5. **Vùng chạm tối thiểu 44 dp**: nếu bàn hiển thị nhỏ hơn 44 dp ở độ zoom hiện tại, mở rộng *vùng chạm* (không phóng to hình): `hit = max(visualSize, 44 / zoom)`.
6. **Nhãn bàn** nhân nghịch đảo độ zoom (`Transform.scale(1 / zoom)` hoặc `FittedBox`) để chữ luôn đọc được.
7. Đổi ảnh nền cùng tỉ lệ → bàn giữ nguyên chỗ; khác tỉ lệ → bắt buộc hỏi "Giữ vị trí tương đối / Đặt lại" (vì `x,y` chuẩn hóa sẽ kéo giãn).

---

## 5. Ảnh mặt bằng: xử lý, lưu trữ, cache

| Khâu | Giải pháp | Lý do |
|---|---|---|
| Nén | **Tại app** trước khi upload: cạnh dài ≤ 2400 px, JPEG q≈82 (hoặc PNG nếu là bản vẽ nét), ≤ ~800 KB; sinh thêm thumbnail 480 px | Tránh thư viện ảnh native (sharp) trên Hostinger; giống cách đã làm với ảnh món/logo |
| Upload | `POST /api/floor-plans` nhận **bytes thô** (`express.raw`, giới hạn 3 MB, như `/backup/upload`), kèm `w`, `h` | Không cần multipart |
| Kiểm tra server | Kiểm tra magic bytes JPEG/PNG, đọc kích thước từ header (không giải mã cả ảnh), từ chối > 3 MB hoặc cạnh > 4000 px | Chống file lạ + chống ngốn RAM |
| Lưu | `media_files` (folder `floorplan`) như ảnh sản phẩm: **không** ghi vào `public/` vì deploy xóa thư mục app. Cần nâng giới hạn của `imageStore` cho folder này (hiện 600 KB) và kiểm tra `max_allowed_packet` ≥ 4 MB và kiểu cột BLOB (`MEDIUMBLOB`) | Tận dụng route `/media/` sẵn có |
| Phục vụ | `/media/<id>-<slug>.jpg` với `Cache-Control: public, max-age=31536000, immutable` (đã có); id mới cho mỗi lần upload → URL không bao giờ trùng nội dung | Cache vĩnh viễn, không cần kiểm tra lại |
| Cache app | Lưu file vào thư mục tài liệu (`path_provider`) theo **`media id`**; lần mở sau đọc đĩa, 0 request. Chỉ tải lại khi `image.url` trong JSON bố cục đổi. Dọn ảnh cũ khi tải ảnh mới | App đã có `dio`, `path_provider`, `sqflite` → không cần thêm package |
| Hiển thị | Hiện **thumbnail mờ** ngay (đã cache) rồi thay bằng ảnh đầy đủ khi giải mã xong; `cacheWidth: 2048` | Mở màn dưới 300 ms cảm nhận được |
| Bố cục | `GET /api/floor-plans/active` với `ETag` (= `version`): app gửi `If-None-Match` → `304` khi không đổi (vài trăm byte). Lưu JSON bố cục vào `snapshot_sync` để dùng offline | Tiết kiệm băng thông, chạy offline |

Dự phòng khi chưa có mặt bằng hoặc offline mà chưa cache ảnh: hiển thị lưới bàn như màn hình hiện tại (`tables_screen.dart`).

---

## 6. API tổng hợp

| Method & path | Quyền | Việc |
|---|---|---|
| `GET /api/floor-plans/active` | nhân viên | Bố cục + trạng thái bàn hiện tại (`ETag`) |
| `POST /api/floor-plans` | admin | Tạo mặt bằng từ ảnh (bytes thô) |
| `PUT /api/floor-plans/:id/image` | admin | Thay ảnh nền (hỏi giữ/đặt lại bàn) |
| `PUT /api/floor-plans/:id/layout` | admin | Lưu bố cục (kiểm `version`) |
| `GET /api/table-kinds` | nhân viên | Loại bàn + sprite |
| `GET /api/tables` (hiện có) | nhân viên | Trạng thái bàn thời gian thực; app làm mới 5–10 s khi đang xem sơ đồ |

Trạng thái bàn (trống/đang phục vụ/ghép, tổng tiền) lấy từ `dining_tables` + `orders` hiện có, nên sơ đồ 2.5D chỉ là **một cách hiển thị khác** của dữ liệu đã có.

---

## 7. Rủi ro & kiểm thử

| Rủi ro | Biện pháp |
|---|---|
| Kéo thả giật trên máy yếu | `RepaintBoundary`, chỉ rebuild bàn đang kéo, tắt phối cảnh khi chỉnh sửa |
| Xung đột cử chỉ (kéo bàn lại pan nền) | Cơ chế `panEnabled` + đếm con trỏ (3.2); test widget bằng `WidgetTester.timedDragFrom` và hai con trỏ |
| Ảnh nặng, tải chậm trên 4G | Nén ở app, thumbnail trước, cache theo id |
| Hai thiết bị cùng sửa bố cục | `version` + `409 STALE_LAYOUT`, hiện hộp thoại "Tải lại / Ghi đè" |
| Dòng cột `dining_tables` mới làm hỏng ghép/tách bàn | Chỉ thêm cột NULL được; `PUT /layout` không đụng các cột trạng thái; thêm test hồi quy |
| Sprite không đồng nhất phong cách | Đặt bộ sprite (6 loại) thành một gói thiết kế duy nhất, vẽ theo cùng góc nhìn ~30° |
| Bản web admin | Có thể dùng chung bố cục: CSS `transform: rotateX()` + ảnh nền; làm sau khi app xong |

**Test:** (1) đơn vị: chuẩn hóa/khử chuẩn hóa tọa độ ở nhiều tỉ lệ màn hình (390×844, 820×1180, 1366×1024) cho cùng kết quả; (2) widget: kéo bàn, pinch-zoom, kéo nền, hủy kéo khi có ngón thứ hai; (3) tích hợp: lưu → mở trên thiết bị khác → bàn đúng vị trí; (4) hiệu năng: 50 bàn trên máy 3 GB RAM đạt ≥ 50 fps.

---

## 8. Lộ trình

| Giai đoạn | Nội dung | Ước lượng |
|---|---|---|
| 1 | Cột mới ở `dining_tables`, bảng `floor_plans`/`table_kinds`, API `GET active` + `PUT layout`, upload ảnh | 3 ngày |
| 2 | Màn **xem** 2.5D: nền, sprite, tilt, trạng thái bàn, chạm mở đơn, cache ảnh/bố cục | 4 ngày |
| 3 | Chế độ **chỉnh sửa**: kéo thả từ thanh công cụ, di chuyển/xoay/phóng, undo/redo, lưu + xung đột phiên bản | 5 ngày |
| 4 | Bộ sprite, tối ưu máy yếu, đo hiệu năng, test | 3 ngày |
| 5 | (Tùy chọn) bản web admin | 2 ngày |
