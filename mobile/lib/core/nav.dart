import 'package:flutter/material.dart';

/// Navigation model mirrored from the Web Admin (views/partials/sidebar.ejs and mobile_nav.ejs).
class NavItem {
  const NavItem({required this.key, required this.label, required this.icon, required this.route, this.adminOnly = false, this.webPath});

  final String key;
  final String label;
  final IconData icon;
  final String route;
  final bool adminOnly;

  /// Set for modules the app does not have yet: they open this Web Admin page in the browser.
  final String? webPath;
}

class NavGroup {
  const NavGroup(this.heading, this.items);
  final String heading;
  final List<NavItem> items;
}

const navGroups = <NavGroup>[
  NavGroup('Vận hành', [
    NavItem(key: 'dashboard', label: 'Tổng quan', icon: Icons.grid_view_rounded, route: '/dashboard'),
    NavItem(key: 'pos', label: 'Bán hàng (POS)', icon: Icons.point_of_sale_rounded, route: '/pos'),
    NavItem(key: 'tables', label: 'Bàn', icon: Icons.table_restaurant_rounded, route: '/tables'),
    NavItem(key: 'orders', label: 'Đơn hàng', icon: Icons.receipt_long_rounded, route: '/orders'),
    NavItem(key: 'customers', label: 'Khách hàng', icon: Icons.groups_rounded, route: '/customers', adminOnly: true),
    NavItem(key: 'menu', label: 'Thực đơn', icon: Icons.local_cafe_rounded, route: '/menu'),
  ]),
  NavGroup('Kho & Định mức', [
    NavItem(key: 'inventory', label: 'Nguyên liệu', icon: Icons.inventory_2_rounded, route: '/inventory'),
    NavItem(key: 'bom', label: 'Công thức (BOM)', icon: Icons.science_rounded, route: '/bom', adminOnly: true),
    NavItem(key: 'receiving', label: 'Nhập kho', icon: Icons.upload_rounded, route: '/receiving', adminOnly: true),
  ]),
  NavGroup('Phân tích', [
    NavItem(key: 'reports', label: 'Báo cáo', icon: Icons.bar_chart_rounded, route: '/reports', adminOnly: true),
    NavItem(key: 'expenses', label: 'Sổ chi phí', icon: Icons.account_balance_wallet_rounded, route: '/expenses', adminOnly: true),
    NavItem(key: 'finance', label: 'Thuế & chi phí', icon: Icons.percent_rounded, route: '/finance', adminOnly: true),
    NavItem(key: 'zalo', label: 'Zalo OA', icon: Icons.chat_rounded, route: '/zalo', adminOnly: true),
  ]),
  NavGroup('Hệ thống', [
    NavItem(key: 'heli', label: 'Trợ lý Heli', icon: Icons.mic_rounded, route: '/heli'),
    NavItem(key: 'settings', label: 'Cài đặt', icon: Icons.tune_rounded, route: '/settings'),
    NavItem(key: 'diagnostics', label: 'Chẩn đoán', icon: Icons.health_and_safety_rounded, route: '/diagnostics'),
    NavItem(key: 'sync', label: 'Đồng bộ ngoại tuyến', icon: Icons.cloud_sync_rounded, route: '/sync'),
  ]),
];

/// Phone bottom bar, same five tabs as the web (mobile_nav.ejs). Index = StatefulShellRoute branch.
const bottomTabs = <NavItem>[
  NavItem(key: 'dashboard', label: 'Tổng quan', icon: Icons.grid_view_rounded, route: '/dashboard'),
  NavItem(key: 'orders', label: 'Đơn hàng', icon: Icons.receipt_long_rounded, route: '/orders'),
  NavItem(key: 'inventory', label: 'Kho', icon: Icons.inventory_2_rounded, route: '/inventory'),
  NavItem(key: 'reports', label: 'Báo cáo', icon: Icons.bar_chart_rounded, route: '/reports'),
  NavItem(key: 'more', label: 'Menu', icon: Icons.menu_rounded, route: '/more'),
];

/// Navigation items that work in local mode ("Dùng trên máy này"); the others need a server and are hidden.
const kLocalNavKeys = {'dashboard', 'pos', 'orders', 'menu', 'reports', 'more', 'settings', 'diagnostics'};

int? branchOf(String route) {
  final i = bottomTabs.indexWhere((t) => t.route == route);
  return i < 0 ? null : i;
}
