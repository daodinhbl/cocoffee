import 'package:flutter/material.dart' hide Thumb;

import '../../../core/format.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/common.dart';
import '../pos_models.dart';

/// Left pane of the web POS: search 'Tìm món…', category tabs ('Tất cả' + categories that have products) and the
/// product grid (tap = +1; count bubble and accent ring when the product is in the cart).
class ProductPane extends StatelessWidget {
  const ProductPane({
    super.key,
    required this.data,
    required this.search,
    required this.query,
    required this.category,
    required this.onQuery,
    required this.onCategory,
    required this.qtyOf,
    required this.onAdd,
    required this.onRefresh,
    this.footer,
  });

  final PosData data;
  final TextEditingController search;
  final String query;
  final int? category;
  final ValueChanged<String> onQuery;
  final ValueChanged<int?> onCategory;
  final int Function(int productId) qtyOf;
  final ValueChanged<PosProduct> onAdd;
  final Future<void> Function() onRefresh;
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    final q = norm(query.trim());
    final list = [
      for (final p in data.products)
        if ((category == null || p.categoryId == category) && (q.isEmpty || norm(p.name).contains(q))) p,
    ];
    final cats = data.usedCategories;
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
        child: TextField(
          controller: search,
          onChanged: onQuery,
          textInputAction: TextInputAction.search,
          style: const TextStyle(fontSize: 16),
          decoration: InputDecoration(
            hintText: 'Tìm món…',
            prefixIcon: const Icon(Icons.search_rounded),
            suffixIcon: query.isEmpty
                ? null
                : IconButton(
                    tooltip: 'Xóa tìm kiếm',
                    icon: const Icon(Icons.close_rounded),
                    onPressed: () {
                      search.clear();
                      onQuery('');
                    },
                  ),
          ),
        ),
      ),
      SizedBox(
        height: 48,
        child: ListView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          children: [
            _CategoryTab(label: 'Tất cả', selected: category == null, onTap: () => onCategory(null)),
            for (final c in cats) ...[
              const SizedBox(width: 8),
              _CategoryTab(label: c.name, selected: category == c.id, onTap: () => onCategory(c.id)),
            ],
          ],
        ),
      ),
      Expanded(
        child: RefreshIndicator(
          onRefresh: onRefresh,
          child: list.isEmpty
              ? ListView(children: const [EmptyState(text: 'Không tìm thấy món phù hợp.', icon: Icons.search_off_rounded)])
              : GridView.builder(
                  padding: const EdgeInsets.fromLTRB(16, 10, 16, 20),
                  gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                    maxCrossAxisExtent: 200,
                    mainAxisExtent: 168,
                    crossAxisSpacing: 12,
                    mainAxisSpacing: 12,
                  ),
                  itemCount: list.length,
                  itemBuilder: (_, i) => ProductCard(product: list[i], qty: qtyOf(list[i].id), onTap: () => onAdd(list[i])),
                ),
        ),
      ),
      ?footer,
    ]);
  }
}

class _CategoryTab extends StatelessWidget {
  const _CategoryTab({required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      selected: selected,
      button: true,
      child: Material(
        color: selected ? Palette.navy : context.cs.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: selected ? Palette.navy : context.co.line),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18),
            child: Center(
              child: Text(label,
                  style: TextStyle(fontWeight: FontWeight.w600, fontSize: 15, color: selected ? Colors.white : context.cs.onSurface)),
            ),
          ),
        ),
      ),
    );
  }
}

/// Product tile: photo (or an emoji guessed from the name), name, price; count bubble when in the cart.
class ProductCard extends StatelessWidget {
  const ProductCard({super.key, required this.product, required this.qty, required this.onTap});
  final PosProduct product;
  final int qty;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final inCart = qty > 0;
    return Material(
      color: context.cs.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: inCart ? Palette.navyAccent : context.co.line, width: inCart ? 2 : 1),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Stack(children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Center(
                child: product.imageUrl != null
                    ? Thumb(url: product.imageUrl, name: product.name, size: 72)
                    : SizedBox(
                        height: 72,
                        child: Center(child: Text(emojiOf(product.name), style: const TextStyle(fontSize: 42, height: 1.2))),
                      ),
              ),
              const Spacer(),
              Text(product.name,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15.5, height: 1.25)),
              const SizedBox(height: 2),
              Text(money(product.price),
                  maxLines: 1,
                  style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 17, color: Palette.navy, fontFeatures: tabular)),
            ]),
          ),
          if (inCart)
            Positioned(
              right: 10,
              top: 10,
              child: Container(
                constraints: const BoxConstraints(minWidth: 28),
                height: 28,
                padding: const EdgeInsets.symmetric(horizontal: 8),
                alignment: Alignment.center,
                decoration: BoxDecoration(color: Palette.navyAccent, borderRadius: BorderRadius.circular(999)),
                child: Text('$qty', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontFeatures: tabular)),
              ),
            ),
        ]),
      ),
    );
  }
}
