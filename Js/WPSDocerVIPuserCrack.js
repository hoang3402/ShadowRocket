var body = $response.body;
var objc = JSON.parse(body);

objc.vips = [{
    "memberid": 12,
    "expire_time": 32495476149,
    "name": "稻壳会员",
    "has_ad": 0,
    "enabled": null
}];

body = JSON.stringify(objc);
$done({
    body
});