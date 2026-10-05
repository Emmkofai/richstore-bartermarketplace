param (
    # Path is passed explicitly by admin-server.js from ACCESS_DB_PATH (.env). No hardcoded default.
    [string]$AccdbPath = ""
)

$ErrorActionPreference = "Stop"

if (!(Test-Path $AccdbPath)) {
    Write-Error "Target MS Access database not found at: $AccdbPath"
    exit 1
}

# Formatting Helpers for MS Access SQL Dialect
function Sql-Str($val) {
    if ($null -eq $val) { return "''" }
    $s = [string]$val
    return "'" + $s.Replace("'", "''") + "'"
}

function Sql-Num($val) {
    if ($null -eq $val -or [string]$val -eq '') { return "0" }
    try {
        return ([double]$val).ToString("0.00", [System.Globalization.CultureInfo]::InvariantCulture)
    } catch {
        return "0"
    }
}

function Sql-Int($val) {
    if ($null -eq $val -or [string]$val -eq '') { return "0" }
    try {
        return [string]([int]$val)
    } catch {
        return "0"
    }
}

function Sql-Bool($val) {
    if ($val -eq $true -or $val -eq 1 -or [string]$val -eq "true") { return "True" }
    return "False"
}

function Sql-Date($val) {
    if ($null -eq $val -or [string]$val -eq '') {
        return "#" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "#"
    }
    $dt = [DateTime]::Now
    if ([DateTime]::TryParse([string]$val, [ref]$dt)) {
        return "#" + $dt.ToString("yyyy-MM-dd HH:mm:ss") + "#"
    }
    return "#" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "#"
}

# 1. Fetch relational data from Node exporter
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$nodeScript = Join-Path $scriptDir "export_relations.js"

$jsonRaw = & node $nodeScript
if (!$jsonRaw) {
    Write-Error "Failed to export relations from database"
    exit 1
}

$relations = $jsonRaw | ConvertFrom-Json

# 2. Connect to MS Access
$connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$AccdbPath;Persist Security Info=False;"
$conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
$conn.Open()
$cmd = $conn.CreateCommand()

function Exec-Sql ($sql) {
    $cmd.CommandText = $sql
    try {
        $cmd.ExecuteNonQuery() | Out-Null
    } catch {
        # Table might already exist
    }
}

# 3. Ensure Table Schemas Exist
Exec-Sql "CREATE TABLE Purchases (OrderId VARCHAR(50) PRIMARY KEY, PlacedAt DATETIME, Buyer VARCHAR(100), ItemCount INTEGER, TotalUnits INTEGER, PricingSubtotal CURRENCY, RevenueGenerated CURRENCY, FinalTotal CURRENCY, SellersInvolved VARCHAR(255))"
Exec-Sql "CREATE TABLE OrderLines (LineId VARCHAR(50) PRIMARY KEY, OrderId VARCHAR(50), ListingId INTEGER, Title VARCHAR(255), Seller VARCHAR(100), SellerPhone VARCHAR(50), Buyer VARCHAR(100), UnitPrice CURRENCY, Quantity INTEGER, LineSubtotal CURRENCY, PlacedAt DATETIME)"
Exec-Sql "CREATE TABLE Users (UserId VARCHAR(50) PRIMARY KEY, Username VARCHAR(100), [Role] VARCHAR(50), Phone VARCHAR(50), IsVerified YESNO, IsAdmin YESNO, ItemsListed INTEGER, ActiveStock INTEGER, UnitsSold INTEGER, GrossSales CURRENCY, PostingFeesPaid CURRENCY, OrdersPlaced INTEGER, UnitsBought INTEGER, TotalSpent CURRENCY, ServiceFeesPaid CURRENCY, TotalRevenueContributed CURRENCY)"
Exec-Sql "CREATE TABLE Listings (ListingId INTEGER PRIMARY KEY, Title VARCHAR(255), Category VARCHAR(100), Price CURRENCY, Stock INTEGER, Condition VARCHAR(50), Seller VARCHAR(100), SellerPhone VARCHAR(50), PostingFeeCollected CURRENCY, UnitsSold INTEGER, GrossSalesGenerated CURRENCY)"
Exec-Sql "CREATE TABLE RevenueLedger (TransactionId VARCHAR(50) PRIMARY KEY, FeeType VARCHAR(50), Description VARCHAR(255), ReferenceId VARCHAR(50), SourceUser VARCHAR(100), Amount CURRENCY, RecordedAt DATETIME)"
Exec-Sql "CREATE TABLE PlatformSummary (SnapshotId INTEGER PRIMARY KEY, GrossMerchandiseValue CURRENCY, TotalPlatformRevenue CURRENCY, PostingFeesCollected CURRENCY, ServiceFeesCollected CURRENCY, AvailableBalance CURRENCY, TotalOrders INTEGER, TotalUnitsSold INTEGER, TotalListings INTEGER, TotalUsers INTEGER, SettlementProvider VARCHAR(50), SettlementAccount VARCHAR(50), SettlementPublicName VARCHAR(50), LastSyncedAt DATETIME)"

# 4. Clear existing records for fresh synchronization
Exec-Sql "DELETE FROM OrderLines"
Exec-Sql "DELETE FROM Purchases"
Exec-Sql "DELETE FROM Users"
Exec-Sql "DELETE FROM Listings"
Exec-Sql "DELETE FROM RevenueLedger"
Exec-Sql "DELETE FROM PlatformSummary"

# 5. Insert Purchases
$purchasesCount = 0
foreach ($p in $relations.purchases) {
    $sellers = if ($p.sellersInvolved) { $p.sellersInvolved -join ", " } else { "N/A" }
    $sql = "INSERT INTO Purchases (OrderId, PlacedAt, Buyer, ItemCount, TotalUnits, PricingSubtotal, RevenueGenerated, FinalTotal, SellersInvolved) VALUES (" +
           (Sql-Str $p.orderId) + ", " +
           (Sql-Date $p.placedAt) + ", " +
           (Sql-Str $p.buyer) + ", " +
           (Sql-Int $p.itemCount) + ", " +
           (Sql-Int $p.totalUnits) + ", " +
           (Sql-Num $p.subtotalPricing) + ", " +
           (Sql-Num $p.revenueGenerated) + ", " +
           (Sql-Num $p.finalTotal) + ", " +
           (Sql-Str $sellers) + ")"
    $cmd.CommandText = $sql
    $cmd.ExecuteNonQuery() | Out-Null
    $purchasesCount++
}

# 6. Insert OrderLines
$orderLinesCount = 0
foreach ($l in $relations.orderItems) {
    $sql = "INSERT INTO OrderLines (LineId, OrderId, ListingId, Title, Seller, SellerPhone, Buyer, UnitPrice, Quantity, LineSubtotal, PlacedAt) VALUES (" +
           (Sql-Str $l.lineId) + ", " +
           (Sql-Str $l.orderId) + ", " +
           (Sql-Int $l.listingId) + ", " +
           (Sql-Str $l.title) + ", " +
           (Sql-Str $l.seller) + ", " +
           (Sql-Str $l.sellerPhone) + ", " +
           (Sql-Str $l.buyer) + ", " +
           (Sql-Num $l.unitPrice) + ", " +
           (Sql-Int $l.qty) + ", " +
           (Sql-Num $l.lineSubtotal) + ", " +
           (Sql-Date $l.placedAt) + ")"
    $cmd.CommandText = $sql
    $cmd.ExecuteNonQuery() | Out-Null
    $orderLinesCount++
}

# 7. Insert Users
$usersCount = 0
foreach ($u in $relations.users) {
    $sql = "INSERT INTO Users (UserId, Username, [Role], Phone, IsVerified, IsAdmin, ItemsListed, ActiveStock, UnitsSold, GrossSales, PostingFeesPaid, OrdersPlaced, UnitsBought, TotalSpent, ServiceFeesPaid, TotalRevenueContributed) VALUES (" +
           (Sql-Str $u.userId) + ", " +
           (Sql-Str $u.username) + ", " +
           (Sql-Str $u.role) + ", " +
           (Sql-Str $u.phone) + ", " +
           (Sql-Bool $u.isVerified) + ", " +
           (Sql-Bool $u.isAdmin) + ", " +
           (Sql-Int $u.seller.itemsListed) + ", " +
           (Sql-Int $u.seller.activeStock) + ", " +
           (Sql-Int $u.seller.unitsSold) + ", " +
           (Sql-Num $u.seller.grossSales) + ", " +
           (Sql-Num $u.seller.postingFeesPaid) + ", " +
           (Sql-Int $u.buyer.ordersCount) + ", " +
           (Sql-Int $u.buyer.unitsBought) + ", " +
           (Sql-Num $u.buyer.totalSpent) + ", " +
           (Sql-Num $u.buyer.serviceFeesPaid) + ", " +
           (Sql-Num $u.totalPlatformRevenueContributed) + ")"
    $cmd.CommandText = $sql
    $cmd.ExecuteNonQuery() | Out-Null
    $usersCount++
}

# 8. Insert Listings
$listingsCount = 0
foreach ($l in $relations.listings) {
    $sql = "INSERT INTO Listings (ListingId, Title, Category, Price, Stock, Condition, Seller, SellerPhone, PostingFeeCollected, UnitsSold, GrossSalesGenerated) VALUES (" +
           (Sql-Int $l.listingId) + ", " +
           (Sql-Str $l.title) + ", " +
           (Sql-Str $l.category) + ", " +
           (Sql-Num $l.price) + ", " +
           (Sql-Int $l.stock) + ", " +
           (Sql-Str $l.condition) + ", " +
           (Sql-Str $l.seller) + ", " +
           (Sql-Str $l.sellerPhone) + ", " +
           (Sql-Num $l.postingFeeCollected) + ", " +
           (Sql-Int $l.unitsSold) + ", " +
           (Sql-Num $l.grossSalesGenerated) + ")"
    $cmd.CommandText = $sql
    $cmd.ExecuteNonQuery() | Out-Null
    $listingsCount++
}

# 9. Insert RevenueLedger
$ledgerCount = 0
foreach ($tx in $relations.revenueLedger) {
    $sql = "INSERT INTO RevenueLedger (TransactionId, FeeType, Description, ReferenceId, SourceUser, Amount, RecordedAt) VALUES (" +
           (Sql-Str $tx.txId) + ", " +
           (Sql-Str $tx.type) + ", " +
           (Sql-Str $tx.description) + ", " +
           (Sql-Str $tx.referenceId) + ", " +
           (Sql-Str $tx.sourceUser) + ", " +
           (Sql-Num $tx.amount) + ", " +
           (Sql-Date $tx.createdAt) + ")"
    $cmd.CommandText = $sql
    $cmd.ExecuteNonQuery() | Out-Null
    $ledgerCount++
}

# 10. Insert PlatformSummary
$s = $relations.summary
$sql = "INSERT INTO PlatformSummary (SnapshotId, GrossMerchandiseValue, TotalPlatformRevenue, PostingFeesCollected, ServiceFeesCollected, AvailableBalance, TotalOrders, TotalUnitsSold, TotalListings, TotalUsers, SettlementProvider, SettlementAccount, SettlementPublicName, LastSyncedAt) VALUES (" +
       "1, " +
       (Sql-Num $s.grossMerchandiseValue) + ", " +
       (Sql-Num $s.totalPlatformRevenue) + ", " +
       (Sql-Num $s.postingFeesCollected) + ", " +
       (Sql-Num $s.serviceFeesCollected) + ", " +
       (Sql-Num $s.availableBalance) + ", " +
       (Sql-Int $s.totalOrders) + ", " +
       (Sql-Int $s.totalUnitsSold) + ", " +
       (Sql-Int $s.totalListings) + ", " +
       (Sql-Int $s.totalUsers) + ", " +
       (Sql-Str $s.settlementAccount.provider) + ", " +
       (Sql-Str $s.settlementAccount.accountNumber) + ", " +
       (Sql-Str $s.settlementAccount.publicName) + ", " +
       (Sql-Date (Get-Date)) + ")"
$cmd.CommandText = $sql
$cmd.ExecuteNonQuery() | Out-Null

$conn.Close()

$resObj = @{
    ok = $true
    syncedAt = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    database = $AccdbPath
    counts = @{
        purchases = $purchasesCount
        orderLines = $orderLinesCount
        users = $usersCount
        listings = $listingsCount
        ledger = $ledgerCount
    }
}

Write-Output ($resObj | ConvertTo-Json -Compress)
